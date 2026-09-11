import crypto from "node:crypto";

import { env } from "../../../config/env.js";
import type {
  CreateOrderInput,
  CreatedOrder,
  PaymentProvider,
  WebhookOutcome,
} from "./types.js";

/**
 * The provider used when no real gateway is configured.
 *
 * It exists so the whole top-up flow — order, callback, verified credit — can
 * be exercised end to end in development and in tests without touching a real
 * gateway or real money. It signs its callbacks with the same secret and the
 * same algorithm a real one would, so the code path under test is the code
 * path that runs in production, not a shortcut around it.
 *
 * `assertProductionConfig` refuses to boot a production deploy that would land
 * here, so a live zone can never take a payment this way by accident.
 */
export class MockProvider implements PaymentProvider {
  readonly name = "mock";

  get configured(): boolean {
    // Deliberately "configured": it is always usable, and production is
    // prevented from reaching it at boot rather than by a flag here.
    return !env.isProd;
  }

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    return {
      orderId: `order_mock_${crypto.randomBytes(8).toString("hex")}`,
      amount: input.amount,
      currency: input.currency,
      mock: true,
    };
  }

  verifyWebhook(rawBody: Buffer | string, headers: Record<string, string | undefined>): boolean {
    const signature = headers["x-seika-signature"] ?? headers["x-razorpay-signature"] ?? "";
    const expected = this.signForTest(
      typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")
    );
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  interpretWebhook(payload: unknown): WebhookOutcome {
    const body = payload as { event?: string; orderId?: string; paymentId?: string };
    if (body?.event === "payment.captured" && body.orderId) {
      return { kind: "paid", orderId: body.orderId, paymentId: body.paymentId };
    }
    if (body?.event === "payment.failed" && body.orderId) {
      return { kind: "failed", orderId: body.orderId };
    }
    return { kind: "ignored", reason: `unhandled event ${body?.event ?? "unknown"}` };
  }

  signForTest(rawBody: string): string {
    return crypto.createHmac("sha256", env.razorpay.webhookSecret).update(rawBody).digest("hex");
  }
}
