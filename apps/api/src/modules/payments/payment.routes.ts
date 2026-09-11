import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, unauthorized } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { env } from "../../config/env.js";
import {
  createOrder,
  verifyWebhookSignature,
  handleWebhookEvent,
  signBodyForTest,
} from "./razorpay.service.js";

export const paymentRouter = Router();

/** Player starts a wallet top-up → returns an order to open in Razorpay checkout. */
paymentRouter.post(
  "/order",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw unauthorized("Players only");
    const { amount } = z.object({ amount: z.number().positive().max(100000) }).parse(req.body);
    const { zoneId } = z.object({ zoneId: z.string() }).parse(req.body);
    const order = await createOrder({ playerId: req.auth!.sub, zoneId, amount });
    res.status(201).json({ ok: true, ...order });
  })
);

/**
 * Razorpay webhook. Uses the raw body (captured in app.ts) for HMAC verification.
 * Credits the wallet on payment.captured.
 */
paymentRouter.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const signature = req.header("x-razorpay-signature") ?? "";
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
    if (!verifyWebhookSignature(raw, signature)) throw unauthorized("Invalid webhook signature");
    const result = await handleWebhookEvent(req.body);
    res.json({ ok: true, ...result });
  })
);

/** DEV-ONLY: simulate a Razorpay captured webhook for a given order (no real gateway). */
paymentRouter.post(
  "/dev/simulate",
  asyncHandler(async (req, res) => {
    if (env.isProd) throw badRequest("disabled");
    const { orderId, paymentId } = z
      .object({ orderId: z.string(), paymentId: z.string().default("pay_dev_1") })
      .parse(req.body);
    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: paymentId, order_id: orderId } } },
    });
    const signature = signBodyForTest(body);
    if (!verifyWebhookSignature(body, signature)) throw badRequest("sign mismatch");
    const result = await handleWebhookEvent(JSON.parse(body));
    res.json({ ok: true, simulated: true, ...result });
  })
);
