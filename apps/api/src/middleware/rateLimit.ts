import type { Request, Response, NextFunction } from "express";
import { tooManyRequests } from "../common/errors.js";
import { env } from "../config/env.js";

/**
 * Fixed-window rate limiter (in-memory). Good enough for a single node; swap the
 * store for Redis in P6 for multi-instance deployments.
 */
interface Bucket {
  count: number;
  resetAt: number;
}
const store = new Map<string, Bucket>();

// Periodic cleanup so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of store) if (b.resetAt < now) store.delete(k);
}, 60_000).unref?.();

export function rateLimit(opts: { windowMs: number; max: number; key?: string }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    // Gated on its own flag, not NODE_ENV, so staging exercises the same path
    // production does — testing-plan case M7 has to be verifiable off-prod.
    if (!env.rateLimitEnabled) return next();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const bucketKey = `${opts.key ?? req.path}:${ip}`;
    const now = Date.now();
    const b = store.get(bucketKey);
    if (!b || b.resetAt < now) {
      store.set(bucketKey, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    if (b.count >= opts.max) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      return next(tooManyRequests(`Rate limit exceeded. Retry in ${retry}s`));
    }
    b.count += 1;
    next();
  };
}

/** Test seam: clears all buckets so cases don't leak limits into each other. */
export function resetRateLimits(): void {
  store.clear();
}
