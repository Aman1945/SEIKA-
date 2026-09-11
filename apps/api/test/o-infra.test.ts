import { describe, it, expect } from "vitest";

import { anon } from "./helpers/factories.js";
import { __testing } from "../src/config/observability.js";

/**
 * Operations-facing behaviour: the endpoints a load balancer and an uptime
 * monitor depend on, and the scrubbing that keeps secrets out of a third
 * party's crash reports.
 */
describe("O. Operations", () => {
  it("liveness reports the build and the database state", async () => {
    const res = await anon().get("/health");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("seika-api");
    expect(res.body.release).toBeTruthy();
    expect(res.body.db).toBe("connected");
    expect(typeof res.body.uptime).toBe("number");
  });

  it("readiness does a real round trip and names each check", async () => {
    const res = await anon().get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // A ping, not just the connection flag — a socket can be "connected" to a
    // primary that is no longer accepting writes.
    expect(res.body.checks.mongo.ok).toBe(true);
    // Redis is optional; unconfigured is ready, configured-and-broken is not.
    expect(res.body.checks.redis.ok).toBe(true);
    expect(res.body.checks.redis.detail).toBe("not configured");
  });

  it("readiness returns 503 when the database is unreachable", async () => {
    const mongoose = (await import("mongoose")).default;
    const admin = mongoose.connection.db!.admin.bind(mongoose.connection.db!);

    // Simulate a primary that stops answering.
    mongoose.connection.db!.admin = (() => ({
      ping: async () => {
        throw new Error("connection refused");
      },
    })) as unknown as typeof admin;

    try {
      const res = await anon().get("/health/ready");
      // 503, not 200 with ok:false — a load balancer reads the status code.
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.checks.mongo.ok).toBe(false);
      expect(res.body.checks.mongo.detail).toContain("connection refused");
    } finally {
      mongoose.connection.db!.admin = admin;
    }
  });

  it("liveness and readiness are public — a monitor holds no credentials", async () => {
    expect((await anon().get("/health")).status).toBe(200);
    expect((await anon().get("/health/ready")).status).toBe(200);
  });

  it("crash reports are scrubbed of secrets before they leave the box", () => {
    const scrubbed = __testing.scrub({
      request: {
        identifier: "9876543210",
        code: "483921",
        devCode: "483921",
        password: "hunter2",
      },
      headers: {
        authorization: "Bearer eyJhbGciOi...",
        "content-type": "application/json",
      },
      session: {
        clientKey: "key-abc123",
        nested: { refreshToken: "rt_secret", signature: "deadbeef" },
      },
      smartSync: { game: "Valorant", payload: "{player config}" },
      amount: 450.5,
    }) as Record<string, Record<string, unknown>>;

    // Credentials and one-time codes are gone...
    expect(scrubbed.request.code).toBe("[redacted]");
    expect(scrubbed.request.devCode).toBe("[redacted]");
    expect(scrubbed.request.password).toBe("[redacted]");
    expect(scrubbed.headers.authorization).toBe("[redacted]");
    expect(scrubbed.session.clientKey).toBe("[redacted]");
    expect((scrubbed.session.nested as Record<string, unknown>).refreshToken).toBe("[redacted]");
    expect((scrubbed.session.nested as Record<string, unknown>).signature).toBe("[redacted]");
    // A player's own game data is theirs, not a vendor's.
    expect((scrubbed.smartSync as Record<string, unknown>).payload).toBe("[redacted]");

    // ...and everything that makes a report actionable is kept.
    expect(scrubbed.request.identifier).toBe("9876543210");
    expect(scrubbed.headers["content-type"]).toBe("application/json");
    expect((scrubbed.smartSync as Record<string, unknown>).game).toBe("Valorant");
    expect(scrubbed.amount as unknown).toBe(450.5);
  });

  it("scrubbing survives arrays, nulls and deep nesting without throwing", () => {
    const out = __testing.scrub({
      list: [{ token: "a" }, { keep: "b" }, null, 3],
      deep: { a: { b: { c: { d: { e: { secret: "x", keep: "y" } } } } } },
      nothing: null,
    }) as Record<string, unknown>;

    const list = out.list as Record<string, unknown>[];
    expect(list[0].token).toBe("[redacted]");
    expect(list[1].keep).toBe("b");
    expect(list[2]).toBeNull();
    expect(out.nothing).toBeNull();
  });

  it("an unknown route is a 404 with a machine-readable code", async () => {
    const res = await anon().get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("malformed JSON is a 400, not a 500", async () => {
    const res = await anon()
      .post("/api/auth/otp/request")
      .set("content-type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  it("the rate limiter sets its headers and degrades without Redis", async () => {
    const { resetRateLimits } = await import("../src/middleware/rateLimit.js");
    const { env } = await import("../src/config/env.js");
    const original = env.rateLimitEnabled;
    (env as { rateLimitEnabled: boolean }).rateLimitEnabled = true;
    resetRateLimits();

    try {
      // No REDIS_URL in the test env, so this exercises the in-process
      // fallback — which must still limit, not silently allow everything.
      const first = await anon().post("/api/auth/otp/request").send({ identifier: "9876500099" });
      expect(first.headers["x-ratelimit-limit"]).toBeTruthy();
      expect(Number(first.headers["x-ratelimit-remaining"])).toBeGreaterThanOrEqual(0);

      let limited: { status: number; headers: Record<string, string> } | null = null;
      for (let i = 0; i < 12; i++) {
        const res = await anon().post("/api/auth/otp/request").send({ identifier: "9876500099" });
        if (res.status === 429) {
          limited = res;
          break;
        }
      }
      expect(limited).not.toBeNull();
      // Retry-After tells a well-behaved client when to come back.
      expect(Number(limited!.headers["retry-after"])).toBeGreaterThan(0);
    } finally {
      (env as { rateLimitEnabled: boolean }).rateLimitEnabled = original;
      resetRateLimits();
    }
  });
});
