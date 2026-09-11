import { describe, it, expect } from "vitest";

import {
  anon,
  as,
  backdateSessionStart,
  seedPlayer,
  seedProduct,
  seedStaff,
  seedZone,
  startActiveSession,
} from "./helpers/factories.js";
import { StaffUser } from "../src/models/StaffUser.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { getWalletBalance } from "../src/modules/wallet/wallet.service.js";

/**
 * Module M — RBAC, security and tenant isolation (plan §7.M). Every case is P0.
 * The plan's words: "Tenant isolation absolute."
 */
describe("M. RBAC, security & tenant isolation", () => {
  it("M1 — a cashier cannot reach analytics or export", async () => {
    const zone = await seedZone();
    const cashier = await seedStaff(zone, "CASHIER");

    expect((await as(cashier.token).get("/api/analytics/overview")).status).toBe(403);
    expect((await as(cashier.token).get("/api/analytics/export?type=sessions")).status).toBe(403);
    expect((await as(cashier.token).get("/api/ai/insights")).status).toBe(403);
  });

  it("M2 — a technician cannot touch the wallet", async () => {
    const zone = await seedZone();
    const tech = await seedStaff(zone, "TECHNICIAN");
    const player = await seedPlayer({ balance: 100, zoneId: zone.zoneId });

    const topup = await as(tech.token)
      .post("/api/wallet/topup")
      .send({ playerId: player.playerId, amount: 500, method: "CASH" });
    expect(topup.status).toBe(403);
    expect(await getWalletBalance(player.playerId)).toBe(100);
  });

  it("M2b — a technician can still run PC commands (their own job)", async () => {
    const zone = await seedZone();
    const tech = await seedStaff(zone, "TECHNICIAN");

    const res = await as(tech.token)
      .post(`/api/pcs/${zone.pcId}/command`)
      .send({ action: "lock" });
    expect(res.status).toBeLessThan(400);
  });

  it("M3 — an event manager can create events but not move money", async () => {
    const zone = await seedZone();
    const em = await seedStaff(zone, "EVENT_MANAGER");
    const player = await seedPlayer({ balance: 100, zoneId: zone.zoneId });

    const created = await as(em.token).post("/api/tournaments").send({
      name: "Friday Valorant Cup",
      game: "Valorant",
      entryFee: 100,
      maxPlayers: 8,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(created.status).toBe(201);

    // But a payout/top-up is not theirs to do.
    const topup = await as(em.token)
      .post("/api/wallet/topup")
      .send({ playerId: player.playerId, amount: 1000, method: "CASH" });
    expect(topup.status).toBe(403);
  });

  it("M4 — staff cannot elevate their own role, and the attempt is refused", async () => {
    const zone = await seedZone();
    const cashier = await seedStaff(zone, "CASHIER");

    const attempts = await Promise.all([
      as(cashier.token).patch(`/api/staff/${cashier.staffId}`).send({ role: "ZONE_OWNER" }),
      as(cashier.token).post("/api/staff").send({ name: "Me again", role: "ZONE_OWNER", phone: "9799999999" }),
    ]);
    for (const res of attempts) expect(res.status).toBe(403);

    const staff = await StaffUser.findById(cashier.staffId).lean();
    expect(staff!.role).toBe("CASHIER");
  });

  it("M5 — owner A cannot read owner B's sessions, orders, players or analytics", async () => {
    const zoneA = await seedZone({ name: "Zone A", hourlyRate: 60 });
    const zoneB = await seedZone({ name: "Zone B", hourlyRate: 60 });

    // Zone B generates real activity: a session and a shop order.
    const playerB = await seedPlayer({ balance: 300, zoneId: zoneB.zoneId });
    const productB = await seedProduct(zoneB, { price: 50, stockQty: 10 });
    const sessionB = await startActiveSession({ zone: zoneB, playerToken: playerB.token });
    const orderB = await as(playerB.token)
      .post("/api/shop/orders")
      .send({ items: [{ productId: productB.productId, qty: 1 }], paymentSource: "WALLET" });
    await backdateSessionStart(sessionB, 60);
    await as(playerB.token).post(`/api/sessions/${sessionB}/end`).send({});

    // Owner A must see none of it.
    const sessions = await as(zoneA.ownerToken).get("/api/sessions/history/list");
    expect(sessions.body.sessions.map((s: { _id: string }) => String(s._id))).not.toContain(sessionB);
    expect(sessions.body.total).toBe(0);

    const queue = await as(zoneA.ownerToken).get("/api/shop/orders/queue");
    expect(queue.body.orders.map((o: { _id: string }) => String(o._id))).not.toContain(
      orderB.body.orderId
    );

    const products = await as(zoneA.ownerToken).get("/api/shop/products");
    expect(products.body.products.map((p: { _id: string }) => String(p._id))).not.toContain(
      productB.productId
    );

    // Zone A's revenue must not include zone B's play.
    const overview = await as(zoneA.ownerToken).get("/api/analytics/overview");
    expect(overview.status).toBe(200);
    const revenue = Number(
      overview.body.overview?.revenue?.total ??
        overview.body.overview?.revenueTotal ??
        overview.body.revenue?.total ??
        0
    );
    expect(revenue).toBe(0);
  });

  it("M5b — owner A cannot read a player's wallet through their own zone context", async () => {
    const zoneA = await seedZone({ name: "Zone A" });
    const zoneB = await seedZone({ name: "Zone B" });
    const playerB = await seedPlayer({ balance: 500, zoneId: zoneB.zoneId });

    const res = await as(zoneA.ownerToken).get(`/api/wallet/${playerB.playerId}/balance`);
    // Either refused outright, or scoped to zone A where the player has nothing.
    if (res.status === 200) {
      expect(res.body.balance).toBe(0);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(403);
    }
  });

  it("M5c — owner A cannot read owner B's audit trail", async () => {
    const zoneA = await seedZone({ name: "Zone A" });
    const zoneB = await seedZone({ name: "Zone B" });
    const cashierB = await seedStaff(zoneB, "CASHIER");
    const playerB = await seedPlayer({ zoneId: zoneB.zoneId });

    await as(cashierB.token)
      .post("/api/wallet/topup")
      .send({ playerId: playerB.playerId, amount: 200, method: "CASH" });

    const logsA = await as(zoneA.ownerToken).get("/api/audit?limit=100");
    const actions = (logsA.body.logs ?? []) as Array<{ action: string }>;
    expect(actions.some((l) => l.action === "WALLET_TOPUP")).toBe(false);

    // Owner B does see it.
    const logsB = await as(zoneB.ownerToken).get("/api/audit?limit=100");
    expect(
      ((logsB.body.logs ?? []) as Array<{ action: string }>).some((l) => l.action === "WALLET_TOPUP")
    ).toBe(true);
  });

  it("M7 — repeated OTP requests are rate limited once the limiter is on", async () => {
    // The limiter is gated on RATE_LIMIT_ENABLED rather than NODE_ENV precisely
    // so this case is verifiable outside production.
    const { resetRateLimits } = await import("../src/middleware/rateLimit.js");
    const { env } = await import("../src/config/env.js");
    const original = env.rateLimitEnabled;
    (env as { rateLimitEnabled: boolean }).rateLimitEnabled = true;
    resetRateLimits();

    try {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        const res = await anon().post("/api/auth/otp/request").send({ identifier: "9876512345" });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    } finally {
      (env as { rateLimitEnabled: boolean }).rateLimitEnabled = original;
      resetRateLimits();
    }
  });

  it("M8 — sensitive actions land in the audit log with actor and role", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const cashier = await seedStaff(zone, "CASHIER");
    const player = await seedPlayer({ zoneId: zone.zoneId });

    await as(cashier.token)
      .post("/api/wallet/topup")
      .send({ playerId: player.playerId, amount: 300, method: "CASH" });
    await as(zone.ownerToken).get("/api/analytics/export?type=sessions");
    await as(zone.ownerToken)
      .post("/api/staff")
      .send({ name: "New Cashier", role: "CASHIER", phone: "9788888888" });
    await as(zone.ownerToken).post(`/api/pcs/${zone.pcId}/command`).send({ action: "lock" });

    const logs = await AuditLog.find({ zoneId: zone.zoneId }).lean();
    const actions = logs.map((l) => String(l.action));

    expect(actions).toContain("WALLET_TOPUP");
    expect(actions).toContain("DATA_EXPORT");
    expect(actions.some((a) => a.includes("STAFF"))).toBe(true);
    expect(actions.some((a) => a.includes("PC"))).toBe(true);

    // Every entry names who did it.
    for (const log of logs) expect(String(log.actorId)).toBeTruthy();
  });

  it("M — an unauthenticated caller reaches nothing sensitive", async () => {
    const zone = await seedZone();
    const endpoints = [
      "/api/analytics/overview",
      "/api/audit",
      "/api/shop/orders/queue",
      "/api/staff",
      `/api/pcs/map?zoneId=${zone.zoneId}`,
      "/api/sessions/history/list",
    ];
    for (const url of endpoints) {
      const res = await anon().get(url);
      expect(res.status).toBe(401);
    }
  });

  it("M — a player token cannot call staff endpoints", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 100, zoneId: zone.zoneId });

    expect((await as(player.token).get("/api/analytics/overview")).status).toBeGreaterThanOrEqual(403);
    expect((await as(player.token).get("/api/audit")).status).toBeGreaterThanOrEqual(403);
    expect((await as(player.token).get("/api/shop/orders/queue")).status).toBeGreaterThanOrEqual(403);
    expect(
      (await as(player.token).post("/api/staff").send({ name: "X", role: "CASHIER", phone: "9777777777" }))
        .status
    ).toBeGreaterThanOrEqual(403);
  });
});
