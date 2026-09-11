import crypto from "node:crypto";
import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { PaymentOrder } from "../../models/PaymentOrder.js";
import { addWalletEntry } from "../wallet/wallet.service.js";
import { withTransaction } from "../../config/db.js";
import { badRequest, unauthorized } from "../../common/errors.js";

/**
 * Creates a payment order. If Razorpay keys are configured, calls the real API;
 * otherwise runs in mock mode (dev) with a locally-generated order id.
 */
export async function createOrder(params: {
  playerId: string;
  zoneId: string;
  amount: number;
}) {
  let orderId: string;

  if (env.razorpay.enabled) {
    const auth = Buffer.from(`${env.razorpay.keyId}:${env.razorpay.keySecret}`).toString("base64");
    const resp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        amount: Math.round(params.amount * 100), // paise
        currency: "INR",
        notes: { playerId: params.playerId, zoneId: params.zoneId },
      }),
    });
    if (!resp.ok) throw badRequest("Razorpay order creation failed");
    orderId = ((await resp.json()) as { id: string }).id;
  } else {
    orderId = `order_mock_${crypto.randomBytes(8).toString("hex")}`;
    logger.warn("Razorpay mock mode — no real keys configured", { orderId });
  }

  await PaymentOrder.create({
    orderId,
    playerId: new mongoose.Types.ObjectId(params.playerId),
    zoneId: new mongoose.Types.ObjectId(params.zoneId),
    amount: mongoose.Types.Decimal128.fromString(params.amount.toFixed(2)),
  });

  return {
    orderId,
    amount: params.amount,
    currency: "INR",
    keyId: env.razorpay.keyId || undefined,
    mock: !env.razorpay.enabled,
  };
}

/** Verifies the webhook HMAC signature (X-Razorpay-Signature). */
export function verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
  const expected = crypto
    .createHmac("sha256", env.razorpay.webhookSecret)
    .update(rawBody)
    .digest("hex");
  // constant-time compare
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Handles a verified webhook event. Credits the wallet exactly once
 * (idempotent on order status) when a payment is captured.
 */
export async function handleWebhookEvent(payload: any) {
  const event = payload?.event as string;
  if (event !== "payment.captured" && event !== "order.paid") {
    return { handled: false, reason: `ignored event ${event}` };
  }
  const entity = payload?.payload?.payment?.entity ?? payload?.payload?.order?.entity;
  const orderId = entity?.order_id ?? entity?.id;
  const paymentId = entity?.id;
  if (!orderId) throw badRequest("No order id in webhook payload");

  const order = await PaymentOrder.findOne({ orderId });
  if (!order) throw badRequest("Unknown order");
  if (order.status === "paid") return { handled: true, alreadyPaid: true }; // idempotent

  const amount = parseFloat(order.amount.toString());
  await withTransaction(async (txn) => {
    order.status = "paid";
    order.paymentId = paymentId;
    await order.save({ session: txn });
    await addWalletEntry(
      {
        playerId: String(order.playerId),
        zoneId: String(order.zoneId),
        amount,
        type: "TOPUP",
        method: "GATEWAY",
        reference: `razorpay:${orderId}`,
        createdBy: "system",
      },
      txn
    );
  });

  return { handled: true, credited: amount, playerId: String(order.playerId) };
}

/** Dev helper: build a signed webhook body to simulate Razorpay in tests. */
export function signBodyForTest(rawBody: string): string {
  if (env.isProd) throw unauthorized("test signing disabled in prod");
  return crypto.createHmac("sha256", env.razorpay.webhookSecret).update(rawBody).digest("hex");
}
