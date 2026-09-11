import { Router } from "express";
import mongoose from "mongoose";

import { env } from "../../config/env.js";
import { redis, redisReady } from "../../config/redis.js";

export const healthRouter = Router();

const DB_STATES = ["disconnected", "connected", "connecting", "disconnecting"];

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [System]
 *     summary: Liveness — is the process up
 */
healthRouter.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "seika-api",
    version: "0.1.0",
    release: env.release,
    env: env.nodeEnv,
    db: DB_STATES[mongoose.connection.readyState] ?? "unknown",
    uptime: Math.round(process.uptime()),
    ts: new Date().toISOString(),
  });
});

/**
 * @openapi
 * /health/ready:
 *   get:
 *     tags: [System]
 *     summary: Readiness — can this instance actually serve traffic
 *
 * Separate from liveness on purpose. A process that is up but cannot reach
 * MongoDB should be taken out of the load balancer, not restarted — and the
 * reverse for a process that has stopped responding. Returns 503 when not
 * ready, which is what an uptime monitor and a rolling deploy both need.
 */
healthRouter.get("/ready", async (_req, res) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // Mongo: a real round trip, not just the connection flag — a socket can be
  // "connected" to a primary that is no longer accepting writes.
  try {
    await mongoose.connection.db!.admin().ping();
    checks.mongo = { ok: true };
  } catch (e) {
    checks.mongo = { ok: false, detail: (e as Error).message };
  }

  // Redis is optional, so "not configured" is ready, but "configured and
  // broken" is not — that is a real degradation someone should see.
  if (!env.redisUrl) {
    checks.redis = { ok: true, detail: "not configured" };
  } else if (redisReady()) {
    try {
      await redis()!.ping();
      checks.redis = { ok: true };
    } catch (e) {
      checks.redis = { ok: false, detail: (e as Error).message };
    }
  } else {
    checks.redis = { ok: false, detail: "configured but not connected" };
  }

  const ready = Object.values(checks).every((c) => c.ok);
  res.status(ready ? 200 : 503).json({
    ok: ready,
    release: env.release,
    checks,
    ts: new Date().toISOString(),
  });
});
