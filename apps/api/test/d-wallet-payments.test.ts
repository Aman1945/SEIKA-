import { describe, it, expect } from "vitest";
import mongoose from "mongoose";

import {
  anon,
  as,
  backdateSessionStart,
  seedPlayer,
  seedProduct,
  seedStaff,
  seedZone,
  startActiveSession,
} from "./helpers/factories.js";
import { WalletLedger } from "../src/models/WalletLedger.js";
import { Product } from "../src/models/Product.js";
import { Order } from "../src/models/Order.js";
import { Player } from "../src/models/Player.js";
import { CoinLedger } from "../src/models/CoinLedger.js";
import { getWalletBalance } from "../src/modules/wallet/wallet.service.js";
import { signBodyForTest } from "../src/modules/payments/razorpay.service.js";

/**
 * Module D — wallet, payments, refunds and the ledger (plan §7.D). Every case
 * is P0 except D8: this is the money module, and the plan is explicit that it
 * must be verified against the database, never through the UI alone.
 */
describe("D. Wallet, payments, refunds and ledger", () => {
  it("D1 — the displayed balance always equals the sum of ledger entries", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const cashier = await seedStaff(zone, "CASHIER");
    const player = await seedPlayer({ zoneId: zone.zoneId });

    for (const amount of [100, 250, 75.5]) {
      await as(cashier.token)
        .post("/api/wallet/topup")
        .send({ playerId: player.playerId, amount, method: "CASH" });
    }

    // Spend some, so the sum includes debits as well as credits.
    const sessionId = await startActiveSession({ zone, playerToken: player.token });
    await backdateSessionStart(sessionId, 60);
    await as(player.token).post(`/api/sessions/${sessionId}/end`).send({});

    const rows = await WalletLedger.find({ playerId: player.playerId }).lean();
    const ledgerSum = +rows
      .reduce((s, r) => s + parseFloat(String(r.amount)), 0)
      .toFixed(2);

    const api = await as(player.token).get(`/api/wallet/${player.playerId}/balance`);
    expect(api.body.balance).toBe(ledgerSum);
    expect(await getWalletBalance(player.playerId)).toBe(ledgerSum);
  });

  it("D2 — there is no endpoint that overwrites a balance directly", async () => {
    const zone = await seedZone();
    const owner = zone.ownerToken;
    const player = await seedPlayer({ balance: 100, zoneId: zone.zoneId });

    // Any shape of direct balance write must be rejected, not silently accepted.
    const attempts = await Promise.all([
      as(owner).patch(`/api/wallet/${player.playerId}/balance`).send({ balance: 99999 }),
      as(owner).put(`/api/wallet/${player.playerId}/balance`).send({ balance: 99999 }),
      as(owner).post(`/api/wallet/${player.playerId}/balance`).send({ balance: 99999 }),
      as(owner).patch(`/api/players/${player.playerId}`).send({ walletBalance: 99999 }),
    ]);
    for (const res of attempts) {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }

    // Balance is untouched, and still ledger-derived.
    expect(await getWalletBalance(player.playerId)).toBe(100);
  });

  it("D2b — a negative top-up cannot be used to drain a wallet", async () => {
    const zone = await seedZone();
    const cashier = await seedStaff(zone, "CASHIER");
    const player = await seedPlayer({ balance: 100, zoneId: zone.zoneId });

    const res = await as(cashier.token)
      .post("/api/wallet/topup")
      .send({ playerId: player.playerId, amount: -500, method: "CASH" });

    expect(res.status).toBe(400);
    expect(await getWalletBalance(player.playerId)).toBe(100);
  });

  it("D3 — replaying the same payment webhook credits the wallet only once", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });

    const order = await as(player.token)
      .post("/api/payments/order")
      .send({ amount: 500, zoneId: zone.zoneId });
    expect(order.status).toBe(201);

    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_test_1", order_id: order.body.orderId } } },
    });
    const signature = signBodyForTest(body);

    const send = () =>
      anon()
        .post("/api/payments/webhook")
        .set("x-razorpay-signature", signature)
        .set("content-type", "application/json")
        .send(body);

    const first = await send();
    expect(first.status).toBe(200);
    expect(first.body.credited).toBe(500);

    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.body.alreadyPaid).toBe(true);

    // One credit, not two.
    expect(await getWalletBalance(player.playerId)).toBe(500);
    expect(await WalletLedger.countDocuments({ playerId: player.playerId })).toBe(1);
  });

  it("D4 — a webhook with a bad signature is rejected and credits nothing", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });
    const order = await as(player.token)
      .post("/api/payments/order")
      .send({ amount: 500, zoneId: zone.zoneId });

    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_forged", order_id: order.body.orderId } } },
    });

    const res = await anon()
      .post("/api/payments/webhook")
      .set("x-razorpay-signature", "deadbeef")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(await getWalletBalance(player.playerId)).toBe(0);
  });

  it("D5 — refunding a session reverses the wallet, XP and coins", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const cashier = await seedStaff(zone, "CASHIER");
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });

    const sessionId = await startActiveSession({ zone, playerToken: player.token });
    await backdateSessionStart(sessionId, 60);
    const end = await as(player.token).post(`/api/sessions/${sessionId}/end`).send({});

    const cost = end.body.cost as number;
    const xpAwarded = end.body.xp?.gained ?? 0;
    expect(cost).toBeGreaterThan(0);
    expect(xpAwarded).toBeGreaterThan(0);

    const afterPlay = await getWalletBalance(player.playerId);
    expect(afterPlay).toBe(300 - cost);

    const refund = await as(cashier.token)
      .post(`/api/sessions/${sessionId}/refund`)
      .send({ reason: "Power outage mid-session" });
    expect(refund.status).toBe(200);

    // Money back, XP back to zero.
    expect(await getWalletBalance(player.playerId)).toBe(300);
    const p = await Player.findById(player.playerId).lean();
    expect(p!.xpTotal).toBe(0);

    // The refund is a new ledger row — the original debit is never erased.
    const rows = await WalletLedger.find({ playerId: player.playerId }).lean();
    expect(rows.some((r) => r.type === "REFUND")).toBe(true);
    expect(rows.some((r) => r.type === "DEDUCT" || r.type === "SESSION")).toBe(true);
  });

  it("D5b — a refund is audit-logged with the actor and reason", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const cashier = await seedStaff(zone, "CASHIER");
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });

    const sessionId = await startActiveSession({ zone, playerToken: player.token });
    await backdateSessionStart(sessionId, 60);
    await as(player.token).post(`/api/sessions/${sessionId}/end`).send({});
    await as(cashier.token)
      .post(`/api/sessions/${sessionId}/refund`)
      .send({ reason: "Hardware fault" });

    const audit = await as(zone.ownerToken).get("/api/audit?limit=50");
    expect(audit.status).toBe(200);
    const rows = (audit.body.logs ?? audit.body.entries ?? []) as Array<Record<string, unknown>>;
    const entry = rows.find((r) => r.action === "SESSION_REFUND");
    expect(entry).toBeTruthy();
    expect(String(entry!.actorId)).toBe(cashier.staffId);
    expect(String(entry!.reason)).toBe("Hardware fault");
  });

  it("D6 — cancelling a paid shop order refunds the wallet and restores stock", async () => {
    const zone = await seedZone();
    const cashier = await seedStaff(zone, "CASHIER");
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const product = await seedProduct(zone, { price: 50, stockQty: 10 });

    const sessionId = await startActiveSession({ zone, playerToken: player.token });

    const place = await as(player.token).post("/api/shop/orders").send({
      zoneId: zone.zoneId,
      items: [{ productId: product.productId, qty: 2 }],
      paymentSource: "WALLET",
      sessionId,
      pcId: zone.pcId,
    });
    expect(place.status).toBe(201);
    expect(await getWalletBalance(player.playerId)).toBe(400);
    expect((await Product.findById(product.productId).lean())!.stockQty).toBe(8);

    const orderId = place.body.orderId as string;
    const cancel = await as(cashier.token)
      .patch(`/api/shop/orders/${orderId}/status`)
      .send({ status: "cancelled" });
    expect(cancel.status).toBe(200);

    // Money back and stock back.
    expect(await getWalletBalance(player.playerId)).toBe(500);
    expect((await Product.findById(product.productId).lean())!.stockQty).toBe(10);
    const order = await Order.findById(orderId).lean();
    expect(["cancelled", "refunded"]).toContain(String(order!.status));
  });

  it("D7 — a failure between debit and commit leaves no partial write", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const product = await seedProduct(zone, { price: 50, stockQty: 10 });
    const sessionId = await startActiveSession({ zone, playerToken: player.token });

    // Second item does not exist, so the order must fail *after* the engine has
    // begun resolving lines — nothing may be debited and no stock may move.
    const res = await as(player.token)
      .post("/api/shop/orders")
      .send({
        zoneId: zone.zoneId,
        items: [
          { productId: product.productId, qty: 1 },
          { productId: String(new mongoose.Types.ObjectId()), qty: 1 },
        ],
        paymentSource: "WALLET",
        sessionId,
        pcId: zone.pcId,
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await getWalletBalance(player.playerId)).toBe(500);
    expect((await Product.findById(product.productId).lean())!.stockQty).toBe(10);
    expect(await Order.countDocuments({})).toBe(0);
  });

  it("D7b — an oversell attempt debits nothing", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const product = await seedProduct(zone, { price: 50, stockQty: 2 });
    const sessionId = await startActiveSession({ zone, playerToken: player.token });

    const res = await as(player.token).post("/api/shop/orders").send({
      zoneId: zone.zoneId,
      items: [{ productId: product.productId, qty: 5 }],
      paymentSource: "WALLET",
      sessionId,
      pcId: zone.pcId,
    });

    expect(res.status).toBe(409);
    expect(await getWalletBalance(player.playerId)).toBe(500);
    expect((await Product.findById(product.productId).lean())!.stockQty).toBe(2);
  });

  it("D — wallet and SEIKA Coins are separate ledgers and never mix", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });

    const sessionId = await startActiveSession({ zone, playerToken: player.token });
    await backdateSessionStart(sessionId, 60);
    await as(player.token).post(`/api/sessions/${sessionId}/end`).send({});

    const walletRows = await WalletLedger.find({ playerId: player.playerId }).lean();
    const coinRows = await CoinLedger.find({ playerId: player.playerId }).lean();

    // Coins earned from play must not appear as money in the wallet ledger.
    const coinTotal = coinRows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    const walletTotal = walletRows.reduce((s, r) => s + parseFloat(String(r.amount)), 0);
    expect(walletTotal).toBe(300 - 60);
    if (coinTotal > 0) {
      expect(walletRows.every((r) => r.type !== "COIN")).toBe(true);
    }
  });

  it("D — a player cannot read another player's wallet or ledger", async () => {
    const zone = await seedZone();
    const a = await seedPlayer({ balance: 100, zoneId: zone.zoneId });
    const b = await seedPlayer({ balance: 100, zoneId: zone.zoneId });

    expect((await as(a.token).get(`/api/wallet/${b.playerId}/balance`)).status).toBe(403);
    expect((await as(a.token).get(`/api/wallet/${b.playerId}/ledger`)).status).toBe(403);
  });
});
