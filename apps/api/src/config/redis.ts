import Redis from "ioredis";

import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Redis, when it is configured. Optional on purpose: a single-instance zone
 * runs fine without it, and local dev should not need another service. What
 * changes when it is present is that state which must be *shared* between API
 * instances (rate-limit counters today) stops being per-process.
 */
let client: Redis | null = null;
let unavailableSince: number | null = null;

export function redis(): Redis | null {
  if (!env.redisUrl) return null;
  if (client) return client;

  client = new Redis(env.redisUrl, {
    // Fail fast and fall back rather than queueing commands behind a dead
    // connection: a rate limiter that hangs is worse than one that degrades.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    lazyConnect: false,
  });

  client.on("ready", () => {
    if (unavailableSince) {
      logger.info("Redis recovered", { downForMs: Date.now() - unavailableSince });
      unavailableSince = null;
    } else {
      logger.info("Redis connected");
    }
  });

  client.on("error", (err) => {
    // One line per outage, not one per command.
    if (!unavailableSince) {
      unavailableSince = Date.now();
      logger.error("Redis unavailable — falling back to in-process state", {
        err: err.message,
      });
    }
  });

  return client;
}

/** True when Redis is configured and currently usable. */
export function redisReady(): boolean {
  const c = redis();
  return Boolean(c && c.status === "ready");
}

export async function disconnectRedis(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => client?.disconnect());
  client = null;
}
