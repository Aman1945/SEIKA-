import { Router } from "express";
import { z } from "zod";

import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, unauthorized } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { env } from "../../config/env.js";
import {
  activeProvider,
  createOrder,
  handleWebhook,
  listProviders,
  signForTest,
} from "./payment.service.js";

export const paymentRouter = Router();

/** Player starts a wallet top-up → returns an order to open in checkout. */
paymentRouter.post(
  "/order",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw unauthorized("Players only");
    const body = z
      .object({
        amount: z.number().positive().max(100_000),
        zoneId: z.string(),
        currency: z.string().length(3).optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());

    const order = await createOrder({ playerId: req.auth!.sub, ...body.data });
    res.status(201).json({ ok: true, ...order });
  })
);

/**
 * Gateway callback.
 *
 * Uses the raw body (captured in app.ts) because a signature is over bytes and
 * re-serialising JSON changes them. The provider is taken from the order, so a
 * zone that switches gateway can still settle in-flight orders from the old one.
 */
paymentRouter.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const raw =
      (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
    const result = await handleWebhook({
      rawBody: raw,
      headers: req.headers as Record<string, string | undefined>,
      payload: req.body,
    });
    res.json({ ok: true, ...result });
  })
);

/** Same, for a provider that needs its own URL. */
paymentRouter.post(
  "/webhook/:provider",
  asyncHandler(async (req, res) => {
    const raw =
      (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
    const result = await handleWebhook({
      providerName: req.params.provider,
      rawBody: raw,
      headers: req.headers as Record<string, string | undefined>,
      payload: req.body,
    });
    res.json({ ok: true, ...result });
  })
);

/** Which gateways this deployment knows about, and which one is live. */
paymentRouter.get(
  "/providers",
  requireAuth,
  requireRole("SUPER_ADMIN", "ZONE_OWNER", "BRANCH_MANAGER"),
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, providers: listProviders(), active: activeProvider().name });
  })
);

/**
 * DEV ONLY: completes an order the way a real gateway's callback would,
 * through the same verification path — not a shortcut around it.
 */
paymentRouter.post(
  "/dev/simulate",
  asyncHandler(async (req, res) => {
    if (env.isProd) throw badRequest("disabled");
    const { orderId, paymentId } = z
      .object({ orderId: z.string(), paymentId: z.string().default("pay_dev_1") })
      .parse(req.body);

    const provider = activeProvider().name;
    const body =
      provider === "razorpay"
        ? JSON.stringify({
            event: "payment.captured",
            payload: { payment: { entity: { id: paymentId, order_id: orderId } } },
          })
        : JSON.stringify({ event: "payment.captured", orderId, paymentId });

    const signature = signForTest(provider, body);
    const result = await handleWebhook({
      providerName: provider,
      rawBody: body,
      headers: { "x-razorpay-signature": signature, "x-seika-signature": signature },
      payload: JSON.parse(body),
    });

    res.json({ ok: true, simulated: true, provider, ...result });
  })
);
