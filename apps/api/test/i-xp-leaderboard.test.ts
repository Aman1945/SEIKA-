import { describe, it, expect } from "vitest";
import mongoose from "mongoose";

import {
  anon,
  as,
  backdateSessionStart,
  qrFor,
  seedPc,
  seedPlayer,
  seedStaff,
  seedZone,
  startActiveSession,
} from "./helpers/factories.js";
import { Player } from "../src/models/Player.js";
import { Session } from "../src/models/Session.js";
import { PC } from "../src/models/PC.js";
import { CoinLedger } from "../src/models/CoinLedger.js";
import { xpFromMinutes } from "../src/modules/xp/xp.service.js";

/** Plays a full session of `minutes` and returns what ending it reported. */
async function playFor(
  zone: Awaited<ReturnType<typeof seedZone>>,
  player: { token: string },
  minutes: number,
  opts: { pcId?: string; game?: string } = {}
) {
  const pcId = opts.pcId ?? zone.pcId;
  const attach = await as(player.token)
    .post("/api/sessions/attach")
    .send({ qrToken: qrFor(pcId) });
  await as(player.token)
    .post(`/api/sessions/${attach.body.sessionId}/authorize`)
    .send({ source: "WALLET", game: opts.game });
  await as(player.token).post(`/api/sessions/${attach.body.sessionId}/start`).send({});
  await backdateSessionStart(attach.body.sessionId, minutes);
  const end = await as(player.token)
    .post(`/api/sessions/${attach.body.sessionId}/end`)
    .send({});
  return { sessionId: attach.body.sessionId as string, end };
}

/**
 * Module I — XP, rank, coins and leaderboards (plan §7.I).
 * I1, I2, I4, I5 and I10 are P0; the leaderboard scopes are P1.
 */
describe("I. XP, rank, coins & leaderboards", () => {
  it("I1 — 60 valid minutes award the configured XP", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const { end } = await playFor(zone, player, 60);
    expect(end.status).toBe(200);
    expect(end.body.validMinutes).toBe(60);
    expect(end.body.xp.gained).toBe(xpFromMinutes(60));

    const p = await Player.findById(player.playerId).lean();
    expect(p!.xpTotal).toBe(xpFromMinutes(60));
  });

  it("I2 — a QR login with no authorized gameplay awards no XP and no coins", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });

    await as(player.token).post("/api/sessions/attach").send({ qrToken: qrFor(zone.pcId) });

    const p = await Player.findById(player.playerId).lean();
    expect(p!.xpTotal).toBe(0);
    expect(await CoinLedger.countDocuments({ playerId: player.playerId })).toBe(0);
  });

  it("I3 — XP follows valid minutes only, so a shorter session earns less", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const a = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const b = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const other = await seedPc(zone, { pcNumber: "PC-02" });

    const long = await playFor(zone, a, 60);
    const short = await playFor(zone, b, 20, { pcId: other.pcId });

    expect(long.end.body.xp.gained).toBeGreaterThan(short.end.body.xp.gained);
    expect(short.end.body.xp.gained).toBe(xpFromMinutes(20));
  });

  it("I4 — crossing a level threshold credits SEIKA Coins", async () => {
    const zone = await seedZone({ hourlyRate: 1 }); // cheap, so long play is affordable
    const player = await seedPlayer({ balance: 5000, zoneId: zone.zoneId });

    // Enough play to cross at least one level boundary.
    await playFor(zone, player, 600);

    const p = await Player.findById(player.playerId).lean();
    expect(p!.level).toBeGreaterThan(1);

    const coinRows = await CoinLedger.find({ playerId: player.playerId }).lean();
    expect(coinRows.length).toBeGreaterThan(0);
    const coinTotal = coinRows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    expect(coinTotal).toBeGreaterThan(0);
  });

  it("I5 — a rank badge and its bonus are granted once, not on every session", async () => {
    const zone = await seedZone({ hourlyRate: 1 });
    const player = await seedPlayer({ balance: 5000, zoneId: zone.zoneId });
    const other = await seedPc(zone, { pcNumber: "PC-02" });

    await playFor(zone, player, 600);
    const afterFirst = await Player.findById(player.playerId).lean();
    const rankAfterFirst = afterFirst!.rank;
    const rankRewardsFirst = await CoinLedger.countDocuments({
      playerId: player.playerId,
      reason: { $regex: /rank/i },
    });

    // Play a short session that changes no rank.
    await playFor(zone, player, 10, { pcId: other.pcId });

    const afterSecond = await Player.findById(player.playerId).lean();
    expect(afterSecond!.rank).toBe(rankAfterFirst);
    const rankRewardsSecond = await CoinLedger.countDocuments({
      playerId: player.playerId,
      reason: { $regex: /rank/i },
    });
    expect(rankRewardsSecond).toBe(rankRewardsFirst);
  });

  it("I6 — the global board ranks players by XP", async () => {
    const zone = await seedZone({ hourlyRate: 1 });
    const other = await seedPc(zone, { pcNumber: "PC-02" });
    const strong = await seedPlayer({ balance: 5000, zoneId: zone.zoneId, name: "Strong" });
    const weak = await seedPlayer({ balance: 5000, zoneId: zone.zoneId, name: "Weak" });

    await playFor(zone, strong, 300);
    await playFor(zone, weak, 60, { pcId: other.pcId });

    const res = await anon().get("/api/leaderboard?scope=global");
    expect(res.status).toBe(200);
    const ids = res.body.leaderboard.map((r: { playerId: string }) => r.playerId);
    expect(ids.indexOf(strong.playerId)).toBeLessThan(ids.indexOf(weak.playerId));
    expect(res.body.leaderboard[0].position).toBe(1);
  });

  it("I7 — region, country and city boards place a player in their own geography", async () => {
    const zone = await seedZone({ hourlyRate: 1 });
    const other = await seedPc(zone, { pcNumber: "PC-02" });

    const pune = await seedPlayer({
      balance: 5000,
      zoneId: zone.zoneId,
      city: "Pune",
      country: "India",
    });
    const dubai = await seedPlayer({
      balance: 5000,
      zoneId: zone.zoneId,
      city: "Dubai",
      country: "UAE",
    });
    await playFor(zone, pune, 300);
    await playFor(zone, dubai, 300, { pcId: other.pcId });

    const city = await anon().get("/api/leaderboard?scope=city&city=Pune");
    const cityIds = city.body.leaderboard.map((r: { playerId: string }) => r.playerId);
    expect(cityIds).toContain(pune.playerId);
    expect(cityIds).not.toContain(dubai.playerId);

    const country = await anon().get("/api/leaderboard?scope=country&country=UAE");
    const countryIds = country.body.leaderboard.map((r: { playerId: string }) => r.playerId);
    expect(countryIds).toContain(dubai.playerId);
    expect(countryIds).not.toContain(pune.playerId);

    // India sits in South Asia; the UAE does not.
    const region = await anon().get("/api/leaderboard?scope=region&region=South Asia");
    const regionIds = region.body.leaderboard.map((r: { playerId: string }) => r.playerId);
    expect(regionIds).toContain(pune.playerId);
    expect(regionIds).not.toContain(dubai.playerId);
  });

  it("I8 — the zone board aggregates only that zone's session XP", async () => {
    const zoneA = await seedZone({ name: "Zone A", hourlyRate: 1 });
    const zoneB = await seedZone({ name: "Zone B", hourlyRate: 1 });
    const inA = await seedPlayer({ balance: 5000, zoneId: zoneA.zoneId });
    const inB = await seedPlayer({ balance: 5000, zoneId: zoneB.zoneId });

    await playFor(zoneA, inA, 120);
    await playFor(zoneB, inB, 300);

    const res = await anon().get(`/api/leaderboard?scope=zone&zoneId=${zoneA.zoneId}`);
    const ids = res.body.leaderboard.map((r: { playerId: string }) => r.playerId);
    expect(ids).toContain(inA.playerId);
    // Zone B's bigger score must not leak into zone A's board.
    expect(ids).not.toContain(inB.playerId);
  });

  it("I8b — a weekly zone board excludes play older than the window", async () => {
    const zone = await seedZone({ hourlyRate: 1 });
    const player = await seedPlayer({ balance: 5000, zoneId: zone.zoneId });

    const { sessionId } = await playFor(zone, player, 120);
    // Age the session out of the weekly window.
    await Session.updateOne(
      { _id: sessionId },
      { $set: { endTime: new Date(Date.now() - 30 * 24 * 3600_000) } }
    );

    const weekly = await anon().get(`/api/leaderboard?scope=zone&zoneId=${zone.zoneId}&period=weekly`);
    expect(weekly.body.leaderboard.map((r: { playerId: string }) => r.playerId)).not.toContain(
      player.playerId
    );

    const allTime = await anon().get(
      `/api/leaderboard?scope=zone&zoneId=${zone.zoneId}&period=all-time`
    );
    expect(allTime.body.leaderboard.map((r: { playerId: string }) => r.playerId)).toContain(
      player.playerId
    );
  });

  it("I9 — the game board ranks only sessions of that game", async () => {
    const zone = await seedZone({ hourlyRate: 1 });
    const other = await seedPc(zone, { pcNumber: "PC-02" });
    // Both PCs offer both games.
    await PC.updateMany(
      { zoneId: new mongoose.Types.ObjectId(zone.zoneId) },
      { $set: { games: ["Valorant", "CS2"] } }
    );

    const valorantPlayer = await seedPlayer({ balance: 5000, zoneId: zone.zoneId });
    const csPlayer = await seedPlayer({ balance: 5000, zoneId: zone.zoneId });

    await playFor(zone, valorantPlayer, 300, { game: "Valorant" });
    await playFor(zone, csPlayer, 300, { pcId: other.pcId, game: "CS2" });

    const valorant = await anon().get("/api/leaderboard?scope=game&game=Valorant");
    const ids = valorant.body.leaderboard.map((r: { playerId: string }) => r.playerId);
    expect(ids).toContain(valorantPlayer.playerId);
    expect(ids).not.toContain(csPlayer.playerId);

    // A game board with no game named must not silently become the global board.
    const noGame = await anon().get("/api/leaderboard?scope=game");
    expect(noGame.body.leaderboard).toHaveLength(0);
  });

  it("I9b — a session cannot claim a game the PC does not offer", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    await PC.updateOne({ _id: zone.pcId }, { $set: { games: ["Valorant"] } });
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const attach = await as(player.token)
      .post("/api/sessions/attach")
      .send({ qrToken: qrFor(zone.pcId) });
    const res = await as(player.token)
      .post(`/api/sessions/${attach.body.sessionId}/authorize`)
      .send({ source: "WALLET", game: "FIFA 25" });

    expect(res.status).toBe(400);
  });

  it("I10 — refunding a session reverses the XP it awarded", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const cashier = await seedStaff(zone, "CASHIER");
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const { sessionId, end } = await playFor(zone, player, 60);
    expect(end.body.xp.gained).toBeGreaterThan(0);

    await as(cashier.token).post(`/api/sessions/${sessionId}/refund`).send({ reason: "Crash" });

    const p = await Player.findById(player.playerId).lean();
    expect(p!.xpTotal).toBe(0);
    expect(p!.level).toBe(1);
  });

  it("I — the passport reports total hours from valid minutes only", async () => {
    const zone = await seedZone({ hourlyRate: 1 });
    const other = await seedPc(zone, { pcNumber: "PC-02" });
    const player = await seedPlayer({ balance: 5000, zoneId: zone.zoneId });

    await playFor(zone, player, 60);
    await playFor(zone, player, 30, { pcId: other.pcId });
    // An abandoned QR scan contributes nothing.
    await as(player.token).post("/api/sessions/attach").send({ qrToken: qrFor(zone.pcId) });

    const completed = await Session.find({
      playerId: player.playerId,
      status: "COMPLETED",
    }).lean();
    const totalMinutes = completed.reduce((s, x) => s + (x.validMinutes ?? 0), 0);
    expect(totalMinutes).toBe(90);

    const passport = await as(player.token).get("/api/players/me/passport");
    expect(passport.status).toBe(200);
    expect(passport.body.passport.xp.total).toBe(xpFromMinutes(60) + xpFromMinutes(30));
  });
});
