import mongoose from "mongoose";

import { PaymentOrder } from "../../models/PaymentOrder.js";
import { badRequest, notFound, unauthorized } from "../../common/errors.js";
import { withTransaction } from "../../config/db.js";
import { logger } from "../../config/logger.js";
import { addWalletEntry } from "../wallet/wallet.service.js";
import { MockProvider } from "./providers/mock.js";
import { RazorpayProvider } from "./providers/razorpay.js";
import type { PaymentProvider } from "./providers/types.js";

/**
 * Payments, provider-agnostic.
 *
 * The providers differ; what happens to the money does not. Every top-up ends
 * as one TOPUP ledger entry, credited exactly once, inside a transaction, only
 * after that provider verified its own callback. A new gateway is a new file in
 * `providers/` — it never gets to touch the ledger.
 */

const razorpay = new RazorpayProvider();
const mock = new MockProvider();

const PROVIDERS: PaymentProvider[] = [razorpay, mock];

/**
 * The provider to use for new orders: the first real one that is configured,
 * and the mock only when nothing real is. Production cannot boot into the mock
 * (`assertProductionConfig` refuses), so this cannot silently take live money
 * through a simulation.
 */
export function activeProvider(): PaymentProvider {
  return PROVIDERS.find((p) => p !== mock && p.configured) ?? mock;
}

export function providerByName(name: string): PaymentProvider | undefined {
  return PROVIDERS.find((p) => p.name === name);
}

/** Every provider SEIKA knows about, for a settings screen. */
export function listProviders() {
  return PROVIDERS.map((p) => ({
    name: p.name,
    configured: p.configured,
    active: p.name === activeProvider().name,
  }));
}

export async function createOrder(params: {
  playerId: string;
  zoneId: string;
  amount: number;
  currency?: string;
}) {
  if (!(params.amount > 0)) throw badRequest("Amount must be positive");

  const provider = activeProvider();
  const currency = params.currency ?? "INR";

  const order = await provider.createOrder({
    amount: params.amount,
    currency,
    reference: { playerId: params.playerId, zoneId: params.zoneId },
  });

  await PaymentOrder.create({
    orderId: order.orderId,
    playerId: new mongoose.Types.ObjectId(params.playerId),
    zoneId: new mongoose.Types.ObjectId(params.zoneId),
    amount: mongoose.Types.Decimal128.fromString(params.amount.toFixed(2)),
    currency,
    // Stored so a callback — and later a refund — is interpreted by the same
    // provider that created the order, even after the active one changes.
    provider: provider.name,
  });

  return {
    orderId: order.orderId,
    amount: order.amount,
    currency: order.currency,
    provider: provider.name,
    keyId: order.publicKey,
    mock: order.mock,
    checkout: order.checkout,
  };
}

/**
 * Handles a callback from any provider.
 *
 * Verification happens against the provider that created the *order*, not the
 * one currently active: a zone that switches gateway still has in-flight orders
 * from the old one, and those callbacks must still be verifiable.
 */
export async function handleWebhook(params: {
  providerName?: string;
  rawBody: Buffer | string;
  headers: Record<string, string | undefined>;
  payload: unknown;
}) {
  // Which provider is speaking. A named route wins; otherwise try each one's
  // interpretation until one recognises an order it owns.
  const named = params.providerName ? providerByName(params.providerName) : undefined;
  if (params.providerName && !named) throw notFound(`Unknown payment provider`);

  const candidates = named ? [named] : PROVIDERS;

  for (const provider of candidates) {
    const outcome = provider.interpretWebhook(params.payload);
    if (outcome.kind === "ignored") continue;

    const order = (await PaymentOrder.findOne({ orderId: outcome.orderId })) as OrderDoc | null;
    if (!order) continue;
    // The order remembers who created it; only that provider may verify it.
    if (order.provider && order.provider !== provider.name) continue;

    if (!provider.verifyWebhook(params.rawBody, params.headers)) {
      // A bad signature is a forgery attempt, not a bad request.
      throw unauthorized("Invalid webhook signature");
    }

    return applyOutcome(order, outcome, provider.name);
  }

  // Nothing recognised it. Returning 200 is correct: providers retry on
  // non-2xx, and retrying an event we will never act on is just noise.
  return { handled: false, reason: "no provider recognised this event" };
}

/** The fields of a PaymentOrder this module actually uses. */
type OrderDoc = {
  _id: unknown;
  playerId: unknown;
  zoneId: unknown;
  amount: { toString(): string };
  status: string;
  provider?: string;
  orderId: string;
  paymentId?: string;
  save(): Promise<unknown>;
};

async function applyOutcome(
  order: OrderDoc | null,
  outcome: { kind: "paid" | "failed"; orderId: string; paymentId?: string; reason?: string },
  providerName: string
) {
  if (!order) return { handled: false, reason: "unknown order" };

  if (outcome.kind === "failed") {
    if (order.status === "created") {
      order.status = "failed";
      await order.save();
    }
    return { handled: true, failed: true, reason: outcome.reason };
  }

  // Idempotency. Providers retry, and a retried capture must not be a second
  // credit — this is the single most expensive bug this module could have.
  if (order.status === "paid") {
    return { handled: true, alreadyPaid: true };
  }

  const amount = parseFloat(order.amount.toString());

  await withTransaction(async (txn) => {
    // Re-read inside the transaction and only move it off "created": two
    // callbacks arriving at once would otherwise both pass the check above.
    const claimed = await PaymentOrder.findOneAndUpdate(
      { _id: order._id, status: "created" },
      { $set: { status: "paid", paymentId: outcome.paymentId, provider: providerName } },
      { new: true, session: txn }
    );
    if (!claimed) {
      // Another callback won the race and has already credited it.
      return;
    }

    await addWalletEntry(
      {
        playerId: String(order.playerId),
        zoneId: String(order.zoneId),
        amount,
        type: "TOPUP",
        method: "GATEWAY",
        reference: `${providerName}:${order.orderId}`,
        createdBy: "system",
      },
      txn
    );
  });

  const settled = await PaymentOrder.findById(order._id).lean();
  if (settled?.status !== "paid") {
    logger.error("Payment order did not settle", { orderId: order.orderId });
    return { handled: false, reason: "order did not settle" };
  }

  return { handled: true, credited: amount, playerId: String(order.playerId), provider: providerName };
}

/** Test/dev helper: signs a body the way the given provider would. */
export function signForTest(providerName: string, rawBody: string): string {
  const provider = providerByName(providerName);
  if (!provider?.signForTest) throw badRequest(`Provider ${providerName} cannot sign test bodies`);
  return provider.signForTest(rawBody);
}
