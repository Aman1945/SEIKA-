import * as Sentry from "@sentry/node";

import { env } from "./env.js";
import { logger } from "./logger.js";

let enabled = false;

/**
 * Error reporting. Must be called before the app is built so Sentry's
 * instrumentation wraps the http layer.
 *
 * Optional by design — no DSN means no reporting and no crash, which keeps
 * local dev and the test suite free of external calls. What it is *not*
 * optional for is production: `assertProductionConfig` warns when a production
 * deploy has no DSN, because a failure nobody is told about is found by a
 * customer.
 */
export function initObservability(): void {
  if (!env.sentryDsn) {
    if (env.isProd) logger.warn("SENTRY_DSN not set — production errors will not be reported");
    return;
  }

  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.nodeEnv,
    release: env.release,
    // Sampled, not everything: traces on a money path are useful, a trace per
    // heartbeat is noise and cost.
    tracesSampleRate: env.isProd ? 0.1 : 0,
    // Nothing here should ever carry a wallet balance or an OTP.
    sendDefaultPii: false,
    beforeSend(event) {
      return scrub(event);
    },
  });

  enabled = true;
  logger.info("Sentry initialised", { environment: env.nodeEnv, release: env.release });
}

/**
 * Keys whose values must never leave the box. An OTP or a token in a crash
 * report is a credential in a third-party system's logs.
 */
const SENSITIVE_KEYS = [
  "code",
  "otp",
  "devcode",
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "clientkey",
  "secret",
  "signature",
  "apikey",
  "authkey",
  "payload", // a Smart Sync bundle is a player's own game data
];

function scrub<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as unknown as T;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.includes(k.toLowerCase()) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out as unknown as T;
}

/** Reports an error, with the actor and route attached but never their secrets. */
export function captureError(
  err: unknown,
  context?: { route?: string; actorId?: string; actorType?: string; extra?: Record<string, unknown> }
): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (context?.route) scope.setTag("route", context.route);
    if (context?.actorType) scope.setTag("actorType", context.actorType);
    // The subject id is an opaque ObjectId, not personal data, and it is what
    // makes a report actionable.
    if (context?.actorId) scope.setUser({ id: context.actorId });
    if (context?.extra) scope.setExtras(scrub(context.extra));
    Sentry.captureException(err);
  });
}

export async function flushObservability(timeoutMs = 2_000): Promise<void> {
  if (!enabled) return;
  await Sentry.flush(timeoutMs).catch(() => undefined);
}

/** Exposed for the test suite. */
export const __testing = { scrub };
