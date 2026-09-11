import { describe, it, expect } from "vitest";

import { anon, as, seedPlayer, seedStaff, seedZone } from "./helpers/factories.js";
import { WalletLedger } from "../src/models/WalletLedger.js";
import { PaymentOrder } from "../src/models/PaymentOrder.js";
import { getWalletBalance } from "../src/modules/wallet/wallet.service.js";
import {
  activeProvider,
  handleWebhook,
  listProviders,
  providerByName,
  signForTest,
} from "../src/modules/payments/payment.service.js";

/**
 * Plan D8 — payment provider abstraction.
 *
 * The gateways differ. What must not differ is what happens to the money: the
 * same normalised ledger entry, credited exactly once, only after that
 * provider verified its own callback.
 */
describe("P. Payment providers", () => {
  it("D8 — every provider produces the same normalised ledger entry", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });

    const order = await as(player.token)
      .post("/api/payments/order")
      .send({ amount: 500, zoneId: zone.zoneId });
    expect(order.status).toBe(201);
    expect(order.body.provider).toBeTruthy();

    // Settle it the way that provider's callback would.
    const res = await as(player.token)
      .post("/api/payments/dev/simulate")
      .send({ orderId: order.body.orderId });
    expect(res.status).toBe(200);
    expect(res.body.credited).toBe(500);

    const rows = await WalletLedger.find({ playerId: player.playerId }).lean();
    expect(rows).toHaveLength(1);
    // Whatever the gateway, the ledger row is the same shape and names the
    // provider in its reference so support can trace it back.
    expect(rows[0].type).toBe("TOPUP");
    expect(rows[0].method).toBe("GATEWAY");
    expect(rows[0].createdBy).toBe("system");
    expect(String(rows[0].reference)).toContain(order.body.provider);
    expect(String(rows[0].reference)).toContain(order.body.orderId);
  });

  it("the order records which provider created it", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });

    const order = await as(player.token)
      .post("/api/payments/order")
      .send({ amount: 250, zoneId: zone.zoneId });

    const stored = await PaymentOrder.findOne({ orderId: order.body.orderId }).lean();
    expect(stored!.provider).toBe(activeProvider().name);
    expect(stored!.status).toBe("created");
    expect(stored!.currency).toBe("INR");
  });

  it("a callback signed by the wrong provider's secret is refused", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });
    const order = await as(player.token)
      .post("/api/payments/order")
      .send({ amount: 500, zoneId: zone.zoneId });

    const body = JSON.stringify({
      event: "payment.captured",
      orderId: order.body.orderId,
      paymentId: "pay_forged",
    });

    await expect(
      handleWebhook({
        rawBody: body,
        headers: { "x-seika-signature": "not-a-real-signature" },
        payload: JSON.parse(body),
      })
    ).rejects.toMatchObject({ status: 401 });

    expect(await getWalletBalance(player.playerId)).toBe(0);
  });

  it("a payload no provider recognises is acknowledged, not retried forever", async () => {
    // Providers retry on a non-2xx, so an event we will never act on must not
    // be answered with an error — that is an infinite retry loop by design.
    const res = await handleWebhook({
      rawBody: JSON.stringify({ event: "subscription.renewed" }),
      headers: {},
      payload: { event: "subscription.renewed" },
    });
    expect(res.handled).toBe(false);
    expect(res.reason).toMatch(/no provider/i);
  });

  it("a failed-payment callback marks the order without crediting anything", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });
    const order = await as(player.token)
      .post("/api/payments/order")
      .send({ amount: 500, zoneId: zone.zoneId });

    const body = JSON.stringify({ event: "payment.failed", orderId: order.body.orderId });
    const res = await handleWebhook({
      providerName: activeProvider().name,
      rawBody: body,
      headers: { "x-seika-signature": signForTest(activeProvider().name, body) },
      payload: JSON.parse(body),
    });

    expect(res.handled).toBe(true);
    expect((res as { failed?: boolean }).failed).toBe(true);
    expect(await getWalletBalance(player.playerId)).toBe(0);

    const stored = await PaymentOrder.findOne({ orderId: order.body.orderId }).lean();
    expect(stored!.status).toBe("failed");
  });

  it("two callbacks arriving at once credit the wallet only once", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });
    const order = await as(player.token)
      .post("/api/payments/order")
      .send({ amount: 750, zoneId: zone.zoneId });

    const body = JSON.stringify({
      event: "payment.captured",
      orderId: order.body.orderId,
      paymentId: "pay_race",
    });
    const headers = { "x-seika-signature": signForTest(activeProvider().name, body) };
    const call = () =>
      handleWebhook({
        providerName: activeProvider().name,
        rawBody: body,
        headers,
        payload: JSON.parse(body),
      });

    // A gateway retrying while the first delivery is still in flight is the
    // normal case, not an exotic one.
    await Promise.all([call(), call(), call()]);

    expect(await getWalletBalance(player.playerId)).toBe(750);
    expect(await WalletLedger.countDocuments({ playerId: player.playerId })).toBe(1);
  });

  it("a webhook for another provider's order is not settled by this one", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });
    const order = await as(player.token)
      .post("/api/payments/order")
      .send({ amount: 400, zoneId: zone.zoneId });

    // The order was created by the active provider; pretend it belongs to a
    // different one, as it would after a zone switches gateway.
    await PaymentOrder.updateOne(
      { orderId: order.body.orderId },
      { $set: { provider: "some-other-gateway" } }
    );

    const body = JSON.stringify({
      event: "payment.captured",
      orderId: order.body.orderId,
      paymentId: "pay_x",
    });
    const res = await handleWebhook({
      rawBody: body,
      headers: { "x-seika-signature": signForTest(activeProvider().name, body) },
      payload: JSON.parse(body),
    });

    expect(res.handled).toBe(false);
    expect(await getWalletBalance(player.playerId)).toBe(0);
  });

  it("each provider verifies only its own signatures", () => {
    const mock = providerByName("mock")!;
    const razorpay = providerByName("razorpay")!;
    const body = JSON.stringify({ event: "payment.captured", orderId: "order_1" });

    const mockSig = mock.signForTest!(body);
    expect(mock.verifyWebhook(body, { "x-seika-signature": mockSig })).toBe(true);
    // Razorpay looks at a different header, so the same bytes do not pass.
    expect(razorpay.verifyWebhook(body, { "x-seika-signature": mockSig })).toBe(false);

    // A signature of a *different* body never verifies.
    const otherSig = mock.signForTest!(JSON.stringify({ event: "payment.captured", orderId: "x" }));
    expect(mock.verifyWebhook(body, { "x-seika-signature": otherSig })).toBe(false);
    // And neither does a missing one.
    expect(mock.verifyWebhook(body, {})).toBe(false);
  });

  it("the razorpay provider reads its own payload shape", () => {
    const razorpay = providerByName("razorpay")!;

    expect(
      razorpay.interpretWebhook({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_1", order_id: "order_1" } } },
      })
    ).toEqual({ kind: "paid", orderId: "order_1", paymentId: "pay_1" });

    expect(
      razorpay.interpretWebhook({
        event: "payment.failed",
        payload: { payment: { entity: { id: "pay_2", order_id: "order_2", error_description: "declined" } } },
      })
    ).toEqual({ kind: "failed", orderId: "order_2", reason: "declined" });

    // An event with no order id cannot be acted on and must not throw.
    expect(razorpay.interpretWebhook({ event: "payment.captured" }).kind).toBe("ignored");
    expect(razorpay.interpretWebhook({}).kind).toBe("ignored");
    expect(razorpay.interpretWebhook(null).kind).toBe("ignored");
  });

  it("owners can see which gateways exist and which one is live", async () => {
    const zone = await seedZone();
    const cashier = await seedStaff(zone, "CASHIER");

    const res = await as(zone.ownerToken).get("/api/payments/providers");
    expect(res.status).toBe(200);
    expect(res.body.providers.map((p: { name: string }) => p.name)).toContain("razorpay");
    expect(res.body.active).toBe(activeProvider().name);

    // It names configuration, so it is not for counter staff.
    expect((await as(cashier.token).get("/api/payments/providers")).status).toBe(403);
    expect((await anon().get("/api/payments/providers")).status).toBe(401);

    // The same list is available in-process for a settings screen.
    expect(listProviders().some((p) => p.active)).toBe(true);
  });

  it("a zero or negative top-up never creates an order", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });

    for (const amount of [0, -100]) {
      const res = await as(player.token)
        .post("/api/payments/order")
        .send({ amount, zoneId: zone.zoneId });
      expect(res.status).toBe(400);
    }
    expect(await PaymentOrder.countDocuments({})).toBe(0);
  });
});
