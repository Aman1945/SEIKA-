import { describe, it, expect } from "vitest";

import {
  as,
  backdateCreatedAt,
  backdateSessionStart,
  qrFor,
  seedPc,
  seedPlayer,
  seedProduct,
  seedStaff,
  seedZone,
  startActiveSession,
  type SeededZone,
} from "./helpers/factories.js";
import { Order } from "../src/models/Order.js";
import { Product } from "../src/models/Product.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { renderCsv } from "../src/modules/analytics/export.service.js";

/** Plays a full session on a given PC and ends it. */
async function play(
  zone: SeededZone,
  player: { token: string },
  minutes: number,
  pcId?: string
) {
  const attach = await as(player.token)
    .post("/api/sessions/attach")
    .send({ qrToken: qrFor(pcId ?? zone.pcId) });
  await as(player.token)
    .post(`/api/sessions/${attach.body.sessionId}/authorize`)
    .send({ source: "WALLET" });
  await as(player.token).post(`/api/sessions/${attach.body.sessionId}/start`).send({});
  await backdateSessionStart(attach.body.sessionId, minutes);
  await as(player.token).post(`/api/sessions/${attach.body.sessionId}/end`).send({});
  return attach.body.sessionId as string;
}

/** Module L — analytics, reports and export (plan §7.L). L6 is P0. */
describe("L. Analytics, reports & export", () => {
  it("L1 — the overview reports today's revenue across sessions and shop", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 1000, zoneId: zone.zoneId });
    const product = await seedProduct(zone, { price: 50, stockQty: 10 });

    await play(zone, player, 60); // ₹60

    // A delivered order counts as shop revenue.
    const other = await seedPc(zone, { pcNumber: "PC-02" });
    const session = await startActiveSession({ zone, playerToken: player.token, pcId: other.pcId });
    const order = await as(player.token)
      .post("/api/shop/orders")
      .send({ items: [{ productId: product.productId, qty: 2 }], paymentSource: "WALLET" });
    await as(zone.ownerToken)
      .patch(`/api/shop/orders/${order.body.orderId}/status`)
      .send({ status: "delivered" });

    const res = await as(zone.ownerToken).get("/api/analytics/overview");
    expect(res.status).toBe(200);
    expect(res.body.overview.breakdown.sessions).toBe(60);
    expect(res.body.overview.breakdown.shop).toBe(100);
    expect(res.body.overview.revenueToday).toBe(160);
    expect(session).toBeTruthy();
  });

  it("L2 — occupancy reports peak hours, idle time and the busiest PC", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const busy = zone.pcId;
    const quiet = await seedPc(zone, { pcNumber: "PC-02" });
    const p1 = await seedPlayer({ balance: 2000, zoneId: zone.zoneId });
    const p2 = await seedPlayer({ balance: 2000, zoneId: zone.zoneId });

    await play(zone, p1, 60, busy);
    await play(zone, p2, 120, busy);
    await play(zone, p1, 15, quiet.pcId);

    const res = await as(zone.ownerToken).get("/api/analytics/occupancy?days=30");
    expect(res.status).toBe(200);
    const occ = res.body.occupancy;

    expect(occ.mostUsed.pcId).toBe(busy);
    expect(occ.mostUsed.minutes).toBe(180);
    expect(occ.leastUsed.pcId).toBe(quiet.pcId);
    expect(occ.playedMinutes).toBe(195);
    // Idle seat-hours exist because capacity far exceeds what was played.
    expect(occ.idleMinutes).toBeGreaterThan(0);
    expect(occ.capacityMinutes).toBeGreaterThan(occ.playedMinutes);
    expect(occ.peakHours.length).toBeGreaterThan(0);
  });

  it("L3 — player analytics separate new from returning players", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const other = await seedPc(zone, { pcNumber: "PC-02" });
    const loyal = await seedPlayer({ balance: 2000, zoneId: zone.zoneId, name: "Loyal" });
    const newcomer = await seedPlayer({ balance: 2000, zoneId: zone.zoneId, name: "Newcomer" });

    await play(zone, loyal, 120);
    await play(zone, newcomer, 30, other.pcId);

    // Age the loyal player's first session past the window so they read as
    // returning rather than new.
    const { Session } = await import("../src/models/Session.js");
    await Session.updateMany(
      { playerId: loyal.playerId },
      { $set: { startTime: new Date(Date.now() - 60 * 86_400_000) } }
    );
    // But give them a recent session too, so they are active in the window.
    await play(zone, loyal, 45);

    const res = await as(zone.ownerToken).get("/api/analytics/players?days=30");
    expect(res.status).toBe(200);
    const stats = res.body.players;

    expect(stats.totalPlayers).toBe(2);
    expect(stats.activeInWindow).toBe(2);
    expect(stats.newPlayers).toBe(1);
    expect(stats.returningPlayers).toBe(1);
    expect(stats.retentionPct).toBe(50);
    // Ranked by time played: the loyal player first.
    expect(stats.topPlayers[0].playerId).toBe(loyal.playerId);
  });

  it("L4 — shop analytics report best sellers and low stock", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 1000, zoneId: zone.zoneId });
    const popular = await seedProduct(zone, { name: "Cola", price: 50, stockQty: 20 });
    const rare = await seedProduct(zone, { name: "Energy Bar", price: 80, stockQty: 20 });
    await startActiveSession({ zone, playerToken: player.token });

    const buy = async (productId: string, qty: number) => {
      const o = await as(player.token)
        .post("/api/shop/orders")
        .send({ items: [{ productId, qty }], paymentSource: "WALLET" });
      await as(zone.ownerToken)
        .patch(`/api/shop/orders/${o.body.orderId}/status`)
        .send({ status: "delivered" });
    };
    await buy(popular.productId, 5);
    await buy(rare.productId, 1);

    // Drive one product under its threshold.
    await Product.updateOne({ _id: rare.productId }, { $set: { stockQty: 1 } });

    const res = await as(zone.ownerToken).get("/api/analytics/shop?days=30");
    expect(res.status).toBe(200);
    const shop = res.body.shop;

    expect(shop.revenue).toBe(5 * 50 + 80);
    expect(shop.ordersDelivered).toBe(2);
    expect(shop.bestSellers[0].name).toBe("Cola");
    expect(shop.bestSellers[0].qty).toBe(5);
    expect(shop.lowStock.map((p: { name: string }) => p.name)).toContain("Energy Bar");
  });

  it("L5 — event analytics count registrations and this zone's own revenue", async () => {
    const zone = await seedZone();
    const em = await seedStaff(zone, "EVENT_MANAGER");
    const p1 = await seedPlayer({ balance: 1000, zoneId: zone.zoneId });
    const p2 = await seedPlayer({ balance: 1000, zoneId: zone.zoneId });

    const created = await as(em.token).post("/api/tournaments").send({
      name: "Sunday Cup",
      game: "Valorant",
      entryFee: 100,
      maxPlayers: 8,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const eventId = created.body.tournamentId ?? created.body.id;

    for (const p of [p1, p2]) {
      await as(p.token)
        .post(`/api/crosszone/events/${eventId}/register`)
        .send({ zoneId: zone.zoneId });
    }

    const res = await as(zone.ownerToken).get("/api/analytics/events");
    expect(res.status).toBe(200);
    expect(res.body.events.totalEvents).toBe(1);
    expect(res.body.events.totalRegistrations).toBe(2);
    expect(res.body.events.revenueThisZone).toBe(200);
    expect(res.body.events.events[0].isHost).toBe(true);
  });

  it("L6 — every dataset exports as CSV with the right rows (P0)", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 1000, zoneId: zone.zoneId });
    const product = await seedProduct(zone, { price: 50, stockQty: 10 });

    const sessionId = await play(zone, player, 60);
    const other = await seedPc(zone, { pcNumber: "PC-02" });
    await startActiveSession({ zone, playerToken: player.token, pcId: other.pcId });
    await as(player.token)
      .post("/api/shop/orders")
      .send({ items: [{ productId: product.productId, qty: 1 }], paymentSource: "WALLET" });
    await as(player.token)
      .post("/api/bookings")
      .send({
        pcId: zone.pcId,
        slotStart: new Date(Date.now() + 7200_000).toISOString(),
        slotEnd: new Date(Date.now() + 10800_000).toISOString(),
      });
    await as(zone.ownerToken).post("/api/tournaments").send({
      name: "Export Cup",
      game: "Valorant",
      entryFee: 50,
      maxPlayers: 8,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    for (const type of ["sessions", "revenue", "players", "shop", "bookings", "events"]) {
      const res = await as(zone.ownerToken).get(`/api/analytics/export?type=${type}&format=csv`);
      expect(res.status, type).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain(`seika-${type}-`);
      // A header line plus at least one row of real data.
      const lines = res.text.trim().split("\n");
      expect(lines.length, `${type} should have rows`).toBeGreaterThan(1);
    }

    // The sessions export carries the real numbers, not placeholders.
    const sessions = await as(zone.ownerToken).get("/api/analytics/export?type=sessions&format=csv");
    expect(sessions.text).toContain(sessionId);
    expect(sessions.text).toContain("60");
  });

  it("L7 — exports also render as Excel and PDF", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 1000, zoneId: zone.zoneId });
    await play(zone, player, 60);

    const xlsx = await as(zone.ownerToken)
      .get("/api/analytics/export?type=sessions&format=xlsx")
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
    expect(xlsx.headers["content-disposition"]).toContain(".xlsx");
    // A real xlsx is a ZIP archive: "PK" magic bytes.
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe("PK");

    const pdf = await as(zone.ownerToken)
      .get("/api/analytics/export?type=sessions&format=pdf")
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    expect((pdf.body as Buffer).length).toBeGreaterThan(1000);
  });

  it("L7b — a date range filters the export", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const other = await seedPc(zone, { pcNumber: "PC-02" });
    const player = await seedPlayer({ balance: 2000, zoneId: zone.zoneId });

    const oldSession = await play(zone, player, 60);
    const recentSession = await play(zone, player, 30, other.pcId);

    // Age one session out of the range.
    const { Session } = await import("../src/models/Session.js");
    await backdateCreatedAt(Session, oldSession, 60);

    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const res = await as(zone.ownerToken).get(
      `/api/analytics/export?type=sessions&format=csv&since=${since}`
    );
    expect(res.text).toContain(recentSession);
    expect(res.text).not.toContain(oldSession);

    // An inverted range is refused rather than returning something misleading.
    const bad = await as(zone.ownerToken).get(
      `/api/analytics/export?type=sessions&format=csv&since=${new Date().toISOString()}&until=${since}`
    );
    expect(bad.status).toBe(400);
  });

  it("L — every export is audit-logged with what was taken", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    await play(zone, player, 60);

    await as(zone.ownerToken).get("/api/analytics/export?type=revenue&format=xlsx");

    const logs = await AuditLog.find({ zoneId: zone.zoneId, action: "DATA_EXPORT" }).lean();
    expect(logs).toHaveLength(1);
    const value = logs[0].newValue as Record<string, unknown>;
    expect(value.type).toBe("revenue");
    expect(value.format).toBe("xlsx");
    expect(Number(value.rows)).toBeGreaterThan(0);
  });

  it("L — an export only ever contains the caller's own zone", async () => {
    const zoneA = await seedZone({ name: "Zone A", hourlyRate: 60 });
    const zoneB = await seedZone({ name: "Zone B", hourlyRate: 60 });
    const playerB = await seedPlayer({ balance: 1000, zoneId: zoneB.zoneId });
    const sessionB = await play(zoneB, playerB, 60);

    const res = await as(zoneA.ownerToken).get("/api/analytics/export?type=sessions&format=csv");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(sessionB);
    expect(res.text).not.toContain(playerB.playerId);
    // Header only.
    expect(res.text.trim().split("\n")).toHaveLength(1);
  });

  it("L — a cashier cannot export, and a player cannot reach analytics at all", async () => {
    const zone = await seedZone();
    const cashier = await seedStaff(zone, "CASHIER");
    const player = await seedPlayer({ zoneId: zone.zoneId });

    for (const url of [
      "/api/analytics/export?type=sessions&format=csv",
      "/api/analytics/occupancy",
      "/api/analytics/players",
      "/api/analytics/shop",
      "/api/analytics/events",
    ]) {
      expect((await as(cashier.token).get(url)).status, url).toBe(403);
      expect((await as(player.token).get(url)).status, url).toBeGreaterThanOrEqual(403);
    }

    // No refused attempt is recorded as a successful export.
    expect(await AuditLog.countDocuments({ action: "DATA_EXPORT" })).toBe(0);
  });

  it("L — CSV values that look like formulas are neutralised", () => {
    // A player-chosen gamer tag ends up in an owner's spreadsheet, so a cell
    // starting with = must not execute when they open it.
    const csv = renderCsv({
      title: "Players",
      columns: [
        { key: "name", label: "Player" },
        { key: "spend", label: "Spend", numeric: true },
      ],
      rows: [
        { name: '=cmd|" /c calc"!A0', spend: 10 },
        { name: "+44 pwner", spend: 20 },
        { name: "Normal, Name", spend: 30 },
      ],
    });

    const lines = csv.split("\n");
    expect(lines[1]).toMatch(/^"'=cmd/);
    expect(lines[2]).toMatch(/^'\+44/);
    // A comma is still quoted properly rather than breaking the column count.
    expect(lines[3]).toContain('"Normal, Name"');
  });
});
