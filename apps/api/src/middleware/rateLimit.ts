import type { Request, Response, NextFunction } from "express";

import { tooManyRequests } from "../common/errors.js";
import { env } from "../config/env.js";
import { redis, redisReady } from "../config/redis.js";
import { logger } from "../config/logger.js";

/**
 * Fixed-window rate limiter.
 *
 * Backed by Redis when it is configured, so the window is shared across API
 * instances — an in-process counter lets an attacker get N attempts per
 * instance, which defeats the point behind a load balancer. Without Redis it
 * falls back to an in-process map, which is correct for a single instance and
 * is what local dev uses.
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

interface Decision {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

function hitLocal(key: string, windowMs: number, max: number): Decision {
  const now = Date.now();
  const b = store.get(key);
  if (!b || b.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0, remaining: max - 1 };
  }
  if (b.count >= max) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((b.resetAt - now) / 1000),
      remaining: 0,
    };
  }
  b.count += 1;
  return { allowed: true, retryAfterSeconds: 0, remaining: max - b.count };
}

/**
 * One INCR plus a conditional EXPIRE, pipelined. The first hit in a window sets
 * the TTL; later hits leave it alone, which is what makes the window fixed
 * rather than sliding forward on every request.
 */
async function hitRedis(key: string, windowMs: number, max: number): Promise<Decision> {
  const client = redis()!;
  const redisKey = `rl:${key}`;
  const [[, countRaw], [, ttlRaw]] = (await client
    .multi()
    .incr(redisKey)
    .pttl(redisKey)
    .exec()) as [[Error | null, number], [Error | null, number]];

  let ttl = ttlRaw;
  if (ttl < 0) {
    await client.pexpire(redisKey, windowMs);
    ttl = windowMs;
  }

  const count = Number(countRaw);
  if (count > max) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)),
      remaining: 0,
    };
  }
  return { allowed: true, retryAfterSeconds: 0, remaining: max - count };
}

export function rateLimit(opts: { windowMs: number; max: number; key?: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Gated on its own flag, not NODE_ENV, so staging exercises the same path
    // production does — testing-plan case M7 has to be verifiable off-prod.
    if (!env.rateLimitEnabled) return next();

    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const bucketKey = `${opts.key ?? req.path}:${ip}`;

    const apply = (d: Decision) => {
      res.setHeader("X-RateLimit-Limit", String(opts.max));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, d.remaining)));
      if (!d.allowed) {
        res.setHeader("Retry-After", String(d.retryAfterSeconds));
        return next(tooManyRequests(`Rate limit exceeded. Retry in ${d.retryAfterSeconds}s`));
      }
      return next();
    };

    if (redisReady()) {
      hitRedis(bucketKey, opts.windowMs, opts.max)
        .then(apply)
        .catch((err) => {
          // Degrade to the local counter rather than letting the limiter take
          // the API down with it.
          logger.warn("Rate limiter fell back to in-process state", { err: String(err) });
          apply(hitLocal(bucketKey, opts.windowMs, opts.max));
        });
      return;
    }

    return apply(hitLocal(bucketKey, opts.windowMs, opts.max));
  };
}

/** Test seam: clears all buckets so cases don't leak limits into each other. */
export function resetRateLimits(): void {
  store.clear();
}
