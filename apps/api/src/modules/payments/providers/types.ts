/**
 * The payment provider contract.
 *
 * SEIKA supports several gateways because a zone in Mumbai and one in Karachi
 * cannot use the same one. What must not vary is what happens to the money:
 * every provider ends up producing the *same* wallet ledger entry, credited
 * exactly once, only after the provider itself has confirmed the payment.
 *
 * A provider is therefore allowed to do three things and no more: create an
 * order, prove that a callback really came from it, and say what that callback
 * means. Crediting the wallet is not a provider's job — the payment service
 * does that, identically, for all of them.
 */

export interface CreateOrderInput {
  amount: number;
  currency: string;
  /** Carried through to the provider so support can match an order later. */
  reference: { playerId: string; zoneId: string };
}

export interface CreatedOrder {
  /** The provider's own order id. Unique per provider; stored as given. */
  orderId: string;
  amount: number;
  currency: string;
  /** Public key or equivalent the client checkout widget needs, if any. */
  publicKey?: string;
  /** True when no real gateway is configured and this is a local simulation. */
  mock: boolean;
  /** Anything else the client needs to open a checkout. */
  checkout?: Record<string, unknown>;
}

/** What a verified callback turned out to mean. */
export type WebhookOutcome =
  | { kind: "paid"; orderId: string; paymentId?: string }
  | { kind: "failed"; orderId: string; reason?: string }
  /** A real but uninteresting event (a refund notice, a test ping). */
  | { kind: "ignored"; reason: string };

export interface PaymentProvider {
  /** Stable id, stored on the order so a refund knows who to ask. */
  readonly name: string;

  /** True when this provider has real credentials configured. */
  readonly configured: boolean;

  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;

  /**
   * Verifies that a callback genuinely came from this provider.
   *
   * Takes the RAW body: re-serialising JSON changes bytes, and a signature is
   * over bytes. Returning false here is what stops a forged webhook from
   * crediting a wallet, so it must never be optimistic.
   */
  verifyWebhook(rawBody: Buffer | string, headers: Record<string, string | undefined>): boolean;

  /** Interprets an already-verified callback. */
  interpretWebhook(payload: unknown): WebhookOutcome;

  /** Signs a body the way this provider would. Test and mock use only. */
  signForTest?(rawBody: string): string;
}
