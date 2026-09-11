import { describe, it, expect } from "vitest";

import {
  as,
  seedPlayer,
  seedProduct,
  seedStaff,
  seedZone,
  startActiveSession,
} from "./helpers/factories.js";
import { Order } from "../src/models/Order.js";
import { Product } from "../src/models/Product.js";
import { getWalletBalance } from "../src/modules/wallet/wallet.service.js";

/**
 * Module H — shop/POS and the seated-zone shop (plan §7.H). H1, H3–H8 are P0.
 * The rule under test: an order is only valid from the zone, PC and session the
 * player is actually seated at.
 */
describe("H. Shop/POS & seated-zone shop", () => {
  it("H1 — an owner creates a product and it appears in that zone's catalogue", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 100, zoneId: zone.zoneId });
    await startActiveSession({ zone, playerToken: player.token });

    const create = await as(zone.ownerToken).post("/api/shop/products").send({
      name: "Cold Coffee",
      category: "beverage",
      price: 80,
      stockQty: 12,
      lowStockThreshold: 3,
    });
    expect(create.status).toBe(201);

    const catalogue = await as(player.token).get("/api/shop/products");
    expect(catalogue.status).toBe(200);
    const names = catalogue.body.products.map((p: { name: string }) => p.name);
    expect(names).toContain("Cold Coffee");
  });

  it("H2 — stock below the threshold raises a low-stock alert for staff", async () => {
    const zone = await seedZone();
    const cashier = await seedStaff(zone, "CASHIER");
    const product = await seedProduct(zone, { name: "Chips", stockQty: 10, lowStockThreshold: 5 });

    let low = await as(cashier.token).get("/api/shop/low-stock");
    expect(low.body.products.map((p: { name: string }) => p.name)).not.toContain("Chips");

    await Product.updateOne({ _id: product.productId }, { $set: { stockQty: 2 } });

    low = await as(cashier.token).get("/api/shop/low-stock");
    expect(low.body.products.map((p: { name: string }) => p.name)).toContain("Chips");
  });

  it("H3 — a seated player sees only their own zone's catalogue", async () => {
    const zoneA = await seedZone({ name: "Zone A" });
    const zoneB = await seedZone({ name: "Zone B" });
    await seedProduct(zoneA, { name: "A-Cola" });
    await seedProduct(zoneB, { name: "B-Pepsi" });

    const player = await seedPlayer({ balance: 300, zoneId: zoneA.zoneId });
    await startActiveSession({ zone: zoneA, playerToken: player.token });

    const res = await as(player.token).get("/api/shop/products");
    const names = res.body.products.map((p: { name: string }) => p.name);
    expect(names).toContain("A-Cola");
    expect(names).not.toContain("B-Pepsi");
  });

  it("H4 — an order is bound to the active session, PC and zone", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });
    const product = await seedProduct(zone, { price: 50, stockQty: 10 });

    const sessionId = await startActiveSession({ zone, playerToken: player.token });

    const res = await as(player.token)
      .post("/api/shop/orders")
      .send({ items: [{ productId: product.productId, qty: 1 }], paymentSource: "WALLET" });

    expect(res.status).toBe(201);
    // The seat is derived server-side, not taken from the request.
    expect(res.body.sessionId).toBe(sessionId);
    expect(res.body.pcId).toBe(zone.pcId);
    expect(res.body.zoneId).toBe(zone.zoneId);

    const order = await Order.findById(res.body.orderId).lean();
    expect(String(order!.sessionId)).toBe(sessionId);
    expect(String(order!.pcId)).toBe(zone.pcId);
  });

  it("H5 — the same binding applies whether the order comes from the PC or the phone", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });
    const product = await seedProduct(zone, { price: 50, stockQty: 10 });
    const sessionId = await startActiveSession({ zone, playerToken: player.token });

    // Two orders from the same seat — one "from the PC overlay", one "from the
    // phone". Both are the same API and must bind identically.
    const fromPc = await as(player.token)
      .post("/api/shop/orders")
      .send({ items: [{ productId: product.productId, qty: 1 }], paymentSource: "WALLET" });
    const fromPhone = await as(player.token)
      .post("/api/shop/orders")
      .send({ items: [{ productId: product.productId, qty: 1 }], paymentSource: "WALLET" });

    expect(fromPc.body.sessionId).toBe(sessionId);
    expect(fromPhone.body.sessionId).toBe(sessionId);
    expect(fromPhone.body.pcId).toBe(fromPc.body.pcId);
  });

  it("H6 — ordering more than stock is refused and nothing is debited", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });
    const product = await seedProduct(zone, { price: 50, stockQty: 3 });
    await startActiveSession({ zone, playerToken: player.token });

    const res = await as(player.token)
      .post("/api/shop/orders")
      .send({ items: [{ productId: product.productId, qty: 4 }], paymentSource: "WALLET" });

    expect(res.status).toBe(409);
    expect(await getWalletBalance(player.playerId)).toBe(300);
    expect((await Product.findById(product.productId).lean())!.stockQty).toBe(3);
  });

  it("H7 — the queue advances received → preparing → ready → delivered", async () => {
    const zone = await seedZone();
    const cashier = await seedStaff(zone, "CASHIER");
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });
    const product = await seedProduct(zone, { price: 50, stockQty: 10 });
    await startActiveSession({ zone, playerToken: player.token });

    const place = await as(player.token)
      .post("/api/shop/orders")
      .send({ items: [{ productId: product.productId, qty: 1 }], paymentSource: "WALLET" });
    expect(place.body.status).toBe("received");

    const queue = await as(cashier.token).get("/api/shop/orders/queue");
    expect(queue.body.orders.map((o: { _id: string }) => String(o._id))).toContain(
      place.body.orderId
    );

    for (const status of ["preparing", "ready", "delivered"]) {
      const res = await as(cashier.token)
        .patch(`/api/shop/orders/${place.body.orderId}/status`)
        .send({ status });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(status);
    }

    // A delivered order leaves the live queue.
    const after = await as(cashier.token).get("/api/shop/orders/queue");
    expect(after.body.orders.map((o: { _id: string }) => String(o._id))).not.toContain(
      place.body.orderId
    );
  });

  it("H7b — the queue returns money as numbers, so a client can add it up", async () => {
    const zone = await seedZone();
    const cashier = await seedStaff(zone, "CASHIER");
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const product = await seedProduct(zone, { name: "Cold Coffee", price: 80, stockQty: 10 });
    await startActiveSession({ zone, playerToken: player.token });

    await as(player.token)
      .post("/api/shop/orders")
      .send({ items: [{ productId: product.productId, qty: 2 }], paymentSource: "WALLET" });

    const queue = await as(cashier.token).get("/api/shop/orders/queue");
    const order = queue.body.orders[0];

    // Decimal128 serialises as an object, and `price * qty` on it is NaN — so
    // both the total and every line price must arrive as real numbers.
    expect(typeof order.total).toBe("number");
    expect(order.total).toBe(160);
    for (const item of order.items) {
      expect(typeof item.price).toBe("number");
      expect(Number.isNaN(item.price)).toBe(false);
    }
    expect(order.items[0].price * order.items[0].qty).toBe(160);
  });

  it("H8 — a player seated in zone A cannot order from zone B", async () => {
    const zoneA = await seedZone({ name: "Zone A" });
    const zoneB = await seedZone({ name: "Zone B" });
    const productB = await seedProduct(zoneB, { name: "B-Pepsi", price: 50, stockQty: 10 });

    const player = await seedPlayer({ balance: 300, zoneId: zoneA.zoneId });
    await startActiveSession({ zone: zoneA, playerToken: player.token });

    // Naming zone B explicitly is refused...
    const claimed = await as(player.token).post("/api/shop/orders").send({
      zoneId: zoneB.zoneId,
      items: [{ productId: productB.productId, qty: 1 }],
      paymentSource: "WALLET",
    });
    expect(claimed.status).toBe(403);

    // ...and so is naming zone B's product without naming the zone, because the
    // product is not in the seated zone's catalogue.
    const sneaky = await as(player.token)
      .post("/api/shop/orders")
      .send({ items: [{ productId: productB.productId, qty: 1 }], paymentSource: "WALLET" });
    expect(sneaky.status).toBe(404);

    // Requesting zone B's catalogue is refused too.
    const catalogue = await as(player.token).get(`/api/shop/products?zoneId=${zoneB.zoneId}`);
    expect(catalogue.status).toBe(403);

    expect(await getWalletBalance(player.playerId)).toBe(300);
    expect(await Order.countDocuments({})).toBe(0);
  });

  it("H8b — a player with no live session cannot order at all", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });
    const product = await seedProduct(zone, { price: 50, stockQty: 10 });

    // No QR attach, no authorization — nobody is seated.
    const res = await as(player.token)
      .post("/api/shop/orders")
      .send({ items: [{ productId: product.productId, qty: 1 }], paymentSource: "WALLET" });

    expect(res.status).toBe(400);
    expect(await getWalletBalance(player.playerId)).toBe(300);
    expect(await Order.countDocuments({})).toBe(0);
  });

  it("H — staff of another zone cannot see this zone's order queue", async () => {
    const zoneA = await seedZone({ name: "Zone A" });
    const zoneB = await seedZone({ name: "Zone B" });
    const player = await seedPlayer({ balance: 300, zoneId: zoneA.zoneId });
    const product = await seedProduct(zoneA, { price: 50, stockQty: 10 });
    await startActiveSession({ zone: zoneA, playerToken: player.token });

    const place = await as(player.token)
      .post("/api/shop/orders")
      .send({ items: [{ productId: product.productId, qty: 1 }], paymentSource: "WALLET" });

    const queueB = await as(zoneB.ownerToken).get("/api/shop/orders/queue");
    expect(queueB.body.orders.map((o: { _id: string }) => String(o._id))).not.toContain(
      place.body.orderId
    );
  });
});
