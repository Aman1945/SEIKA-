import crypto from "node:crypto";

import { env } from "../../../config/env.js";
import { badRequest } from "../../../common/errors.js";
import type {
  CreateOrderInput,
  CreatedOrder,
  PaymentProvider,
  WebhookOutcome,
} from "./types.js";

/** Razorpay — the India-first gateway, and the only one wired to real keys. */
export class RazorpayProvider implements PaymentProvider {
  readonly name = "razorpay";

  get configured(): boolean {
    return env.razorpay.enabled;
  }

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const auth = Buffer.from(`${env.razorpay.keyId}:${env.razorpay.keySecret}`).toString("base64");
    const resp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        // Razorpay counts in paise, and rounding here rather than at the edges
        // is what keeps the order and the ledger entry equal to the rupee.
        amount: Math.round(input.amount * 100),
        currency: input.currency,
        notes: input.reference,
      }),
    });

    if (!resp.ok) {
      throw badRequest(`Razorpay rejected the order (HTTP ${resp.status})`);
    }
    const body = (await resp.json()) as { id: string };

    return {
      orderId: body.id,
      amount: input.amount,
      currency: input.currency,
      publicKey: env.razorpay.keyId,
      mock: false,
    };
  }

  verifyWebhook(rawBody: Buffer | string, headers: Record<string, string | undefined>): boolean {
    const signature = headers["x-razorpay-signature"] ?? "";
    const expected = crypto
      .createHmac("sha256", env.razorpay.webhookSecret)
      .update(rawBody)
      .digest("hex");

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    // Length check first: timingSafeEqual throws on a mismatch, and a thrown
    // verifier reads as a server error rather than a rejected forgery.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  interpretWebhook(payload: unknown): WebhookOutcome {
    const body = payload as {
      event?: string;
      payload?: {
        payment?: { entity?: { id?: string; order_id?: string; error_description?: string } };
        order?: { entity?: { id?: string } };
      };
    };

    const event = body?.event;
    const payment = body?.payload?.payment?.entity;
    const order = body?.payload?.order?.entity;
    const orderId = payment?.order_id ?? order?.id;

    if (!orderId) return { kind: "ignored", reason: "no order id in payload" };

    if (event === "payment.captured" || event === "order.paid") {
      return { kind: "paid", orderId, paymentId: payment?.id };
    }
    if (event === "payment.failed") {
      return { kind: "failed", orderId, reason: payment?.error_description };
    }
    return { kind: "ignored", reason: `unhandled event ${event ?? "unknown"}` };
  }

  signForTest(rawBody: string): string {
    return crypto.createHmac("sha256", env.razorpay.webhookSecret).update(rawBody).digest("hex");
  }
}
