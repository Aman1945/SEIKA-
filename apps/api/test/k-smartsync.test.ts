import { describe, it, expect } from "vitest";

import {
  as,
  seedPc,
  seedPlayer,
  seedStaff,
  seedZone,
  staffToken,
  startActiveSession,
} from "./helpers/factories.js";
import { GameSyncProfile, PlayerGameConfig } from "../src/models/GameSyncProfile.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { decidePath } from "../src/modules/smartsync/smartsync.service.js";
import { PC } from "../src/models/PC.js";
import mongoose from "mongoose";

const VALORANT_PROFILE = {
  game: "Valorant",
  syncPaths: ["Config", "Saved/Config/WindowsClient"],
  excludePaths: ["Config/Telemetry"],
  enabled: true,
};

async function seedProfile(overrides: Partial<typeof VALORANT_PROFILE> = {}) {
  return GameSyncProfile.create({ ...VALORANT_PROFILE, ...overrides });
}

/** A platform admin token — profile vetting is platform level, not per zone. */
function superAdminToken() {
  return staffToken(String(new mongoose.Types.ObjectId()), "SUPER_ADMIN");
}

/**
 * Module K — Smart Sync (plan §7.K). K5 (forbidden folders) and K6 (anti-cheat
 * safety) are P0: getting these wrong leaks a player's private files or gets
 * them banned from a game.
 */
describe("K. Smart Sync", () => {
  it("K1 — only vetted, enabled games are syncable", async () => {
    await seedProfile();
    await seedProfile({ game: "CS2", syncPaths: ["cfg"], enabled: false });

    const zone = await seedZone();
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });

    const res = await as(player.token).get("/api/smartsync/games");
    expect(res.status).toBe(200);
    const games = res.body.games.map((g: { game: string }) => g.game);
    expect(games).toContain("Valorant");
    // Vetted but not switched on yet — not offered.
    expect(games).not.toContain("CS2");

    // And a disabled game refuses a sync outright.
    await startActiveSession({ zone, playerToken: player.token });
    expect((await as(player.token).get("/api/smartsync/config/CS2")).status).toBe(403);
    // An unknown game is a 404, not a silent empty success.
    expect((await as(player.token).get("/api/smartsync/config/Minesweeper")).status).toBe(404);
  });

  it("K2 — config downloads once the player has an authorized session", async () => {
    await seedProfile();
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });

    // No session yet: nothing to sync to.
    const tooEarly = await as(player.token).get("/api/smartsync/config/Valorant");
    expect(tooEarly.status).toBe(400);

    await startActiveSession({ zone, playerToken: player.token });

    // First time on this game: empty, and that is not an error.
    const first = await as(player.token).get("/api/smartsync/config/Valorant");
    expect(first.status).toBe(200);
    expect(first.body.config.exists).toBe(false);
    expect(first.body.config.version).toBe(0);
  });

  it("K3 — config uploads after the session and comes back on the next one", async () => {
    await seedProfile();
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const sessionId = await startActiveSession({ zone, playerToken: player.token });

    const upload = await as(player.token).post("/api/smartsync/config/Valorant").send({
      payload: JSON.stringify({ sensitivity: 0.42, crosshair: "small-dot" }),
      paths: ["Config/GameUserSettings.ini", "Saved/Config/WindowsClient/Input.ini"],
      baseVersion: 0,
    });
    expect(upload.status).toBe(200);
    expect(upload.body.version).toBe(1);

    await as(player.token).post(`/api/sessions/${sessionId}/end`).send({});

    // Next visit, on a different PC in the same zone.
    const otherPc = await seedPc(zone, { pcNumber: "PC-02" });
    await startActiveSession({ zone, playerToken: player.token, pcId: otherPc.pcId });

    const download = await as(player.token).get("/api/smartsync/config/Valorant");
    expect(download.body.config.exists).toBe(true);
    expect(download.body.config.version).toBe(1);
    expect(JSON.parse(download.body.config.payload).sensitivity).toBe(0.42);
  });

  it("K4 — a second PC writing the same game is a conflict, not an overwrite", async () => {
    await seedProfile();
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 1000, zoneId: zone.zoneId });
    const pcA = zone.pcId;
    const pcB = await seedPc(zone, { pcNumber: "PC-02" });

    // PC A plays and uploads → version 1.
    const sessionA = await startActiveSession({ zone, playerToken: player.token, pcId: pcA });
    await as(player.token).post("/api/smartsync/config/Valorant").send({
      payload: JSON.stringify({ from: "A" }),
      paths: ["Config/GameUserSettings.ini"],
      baseVersion: 0,
    });
    await as(player.token).post(`/api/sessions/${sessionA}/end`).send({});

    // PC B downloads version 1, then A's newer write lands first.
    const sessionB = await startActiveSession({ zone, playerToken: player.token, pcId: pcB.pcId });
    const seen = await as(player.token).get("/api/smartsync/config/Valorant");
    expect(seen.body.config.version).toBe(1);

    await PlayerGameConfig.updateOne(
      { playerId: player.playerId, game: "Valorant" },
      { $set: { version: 2, payload: JSON.stringify({ from: "A-again" }) } }
    );

    // B uploads from the stale base → refused, with both versions named.
    const stale = await as(player.token).post("/api/smartsync/config/Valorant").send({
      payload: JSON.stringify({ from: "B" }),
      paths: ["Config/GameUserSettings.ini"],
      baseVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/another PC/i);

    // The stored copy is untouched until the player chooses.
    const stored = await PlayerGameConfig.findOne({ playerId: player.playerId }).lean();
    expect(JSON.parse(stored!.payload).from).toBe("A-again");

    // Choosing "keep mine" goes through explicitly.
    const forced = await as(player.token).post("/api/smartsync/config/Valorant").send({
      payload: JSON.stringify({ from: "B" }),
      paths: ["Config/GameUserSettings.ini"],
      baseVersion: 1,
      onConflict: "overwrite",
    });
    expect(forced.status).toBe(200);
    expect(forced.body.conflict).toBe(true);
    expect(sessionB).toBeTruthy();
  });

  it("K5 — private and system folders are refused (P0)", async () => {
    await seedProfile();
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    await startActiveSession({ zone, playerToken: player.token });

    const forbiddenPaths = [
      "AppData/Roaming/discord/Local Storage/leveldb/000003.log",
      "AppData/Local/Google/Chrome/User Data/Default/Cookies",
      "AppData/Local/Google/Chrome/User Data/Default/Login Data",
      "AppData/Roaming/Mozilla/Firefox/Profiles/abc.default/key4.db",
      "Documents/tax-returns-2025.pdf",
      "Desktop/passwords.txt",
      "Downloads/bank-statement.pdf",
      ".ssh/id_rsa",
      "Windows/System32/config/SAM",
      "Config/../../../etc/passwd",
      "C:/Users/player/Documents/private.txt",
      "/etc/shadow",
      "Config/cheat-loader.exe",
      "Config/inject.dll",
    ];

    for (const path of forbiddenPaths) {
      const res = await as(player.token).post("/api/smartsync/config/Valorant").send({
        payload: "{}",
        paths: [path],
        baseVersion: 0,
      });
      expect(res.status, `${path} should be refused`).toBe(403);
    }

    // Nothing was stored by any of those attempts.
    expect(await PlayerGameConfig.countDocuments({})).toBe(0);
  });

  it("K5b — one bad path refuses the whole bundle", async () => {
    await seedProfile();
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    await startActiveSession({ zone, playerToken: player.token });

    // A legitimate bundle with one private file smuggled in.
    const res = await as(player.token).post("/api/smartsync/config/Valorant").send({
      payload: "{}",
      paths: [
        "Config/GameUserSettings.ini",
        "Saved/Config/WindowsClient/Input.ini",
        "AppData/Roaming/discord/tokens.json",
      ],
      baseVersion: 0,
    });

    expect(res.status).toBe(403);
    // A half-screened bundle is not stored and hoped about.
    expect(await PlayerGameConfig.countDocuments({})).toBe(0);
  });

  it("K6 — anti-cheat paths are excluded and the attempt is logged (P0)", async () => {
    // Even a profile that mistakenly whitelists the anti-cheat folder.
    await seedProfile({ syncPaths: ["Config", "EasyAntiCheat"] });
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    await startActiveSession({ zone, playerToken: player.token });

    const acPaths = [
      "EasyAntiCheat/Certificates/cert.dat",
      "Config/BattlEye/BEClient.cfg",
      "Config/vanguard/vgk.state",
      "Config/faceit/machine.id",
    ];

    for (const path of acPaths) {
      const res = await as(player.token).post("/api/smartsync/config/Valorant").send({
        payload: "{}",
        paths: [path],
        baseVersion: 0,
      });
      expect(res.status, `${path} should be refused`).toBe(403);
    }

    // The refusal is on the record — this is what support needs later.
    const logs = await AuditLog.find({ action: "SMARTSYNC_ANTICHEAT_BLOCKED" }).lean();
    expect(logs.length).toBe(acPaths.length);
    expect(String(logs[0].actorId)).toBe(player.playerId);
    expect(JSON.stringify(logs[0].newValue)).toMatch(/anti-cheat/i);
  });

  it("K6b — a profile's own exclusions are honoured inside an allowed root", async () => {
    await seedProfile();
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    await startActiveSession({ zone, playerToken: player.token });

    // Config is whitelisted, but Config/Telemetry is carved out.
    const res = await as(player.token).post("/api/smartsync/config/Valorant").send({
      payload: "{}",
      paths: ["Config/Telemetry/hwid.json"],
      baseVersion: 0,
    });
    expect(res.status).toBe(403);

    const logs = await AuditLog.find({ action: "SMARTSYNC_PATH_BLOCKED" }).lean();
    expect(logs.length).toBe(1);
  });

  it("K — the pre-flight screen tells the kiosk exactly what to pack", async () => {
    await seedProfile();
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    await startActiveSession({ zone, playerToken: player.token });

    const res = await as(player.token)
      .post("/api/smartsync/screen")
      .send({
        game: "Valorant",
        paths: [
          "Config/GameUserSettings.ini",
          "Config/Telemetry/hwid.json",
          "AppData/Roaming/discord/tokens.json",
          "EasyAntiCheat/cert.dat",
          "Saved/Config/WindowsClient/Input.ini",
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.allowed).toEqual([
      "Config/GameUserSettings.ini",
      "Saved/Config/WindowsClient/Input.ini",
    ]);
    expect(res.body.refused).toHaveLength(3);
    // Every refusal explains itself, so the kiosk can show the player why.
    expect(res.body.refused.every((r: { reason: string }) => r.reason.length > 0)).toBe(true);
  });

  it("K — an oversized bundle is refused with a clear limit", async () => {
    await seedProfile();
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    await startActiveSession({ zone, playerToken: player.token });

    // Over Smart Sync's own 2MB cap but under the request-body limit, so the
    // service's message is what the player sees.
    const res = await as(player.token)
      .post("/api/smartsync/config/Valorant")
      .send({
        payload: "x".repeat(3 * 1024 * 1024),
        paths: ["Config/GameUserSettings.ini"],
        baseVersion: 0,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/limit is 2048KB/);
  });

  it("K — a body past the request limit is a 413, never a 500", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    const res = await as(player.token)
      .post("/api/smartsync/screen")
      .send({ game: "Valorant", padding: "x".repeat(7 * 1024 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("K — only a platform admin may vet a game's sync paths", async () => {
    const zone = await seedZone();
    const manager = await seedStaff(zone, "BRANCH_MANAGER");

    // A zone owner widening this would put every other zone's players at risk.
    expect(
      (await as(zone.ownerToken).post("/api/smartsync/profiles").send(VALORANT_PROFILE)).status
    ).toBe(403);
    expect(
      (await as(manager.token).post("/api/smartsync/profiles").send(VALORANT_PROFILE)).status
    ).toBe(403);

    const admin = await as(superAdminToken()).post("/api/smartsync/profiles").send(VALORANT_PROFILE);
    expect(admin.status).toBe(201);
  });

  it("K — the path decision itself is strict about what it allows", () => {
    const profile = { syncPaths: ["Config"], excludePaths: ["Config/Telemetry"] };

    expect(decidePath({ path: "Config/settings.ini", ...profile }).allowed).toBe(true);
    expect(decidePath({ path: "config/settings.ini", ...profile }).allowed).toBe(true); // case
    expect(decidePath({ path: "Config\\settings.ini", ...profile }).allowed).toBe(true); // windows sep

    // Not inside a whitelisted root.
    expect(decidePath({ path: "Other/settings.ini", ...profile }).allowed).toBe(false);
    // A sibling directory that merely shares a prefix is not inside it.
    expect(decidePath({ path: "ConfigBackup/settings.ini", ...profile }).allowed).toBe(false);
    // Empty whitelist syncs nothing.
    expect(decidePath({ path: "Config/x.ini", syncPaths: [], excludePaths: [] }).allowed).toBe(false);
    // Anti-cheat wins over an over-broad whitelist.
    expect(
      decidePath({ path: "Config/EasyAntiCheat/c.dat", syncPaths: ["Config"], excludePaths: [] })
        .antiCheat
    ).toBe(true);
  });

  it("K — a player cannot sync using another player's session", async () => {
    await seedProfile();
    const zone = await seedZone();
    await PC.updateOne({ _id: zone.pcId }, { $set: { games: ["Valorant"] } });
    const seated = await seedPlayer({ balance: 500, zoneId: zone.zoneId });
    const bystander = await seedPlayer({ balance: 500, zoneId: zone.zoneId });

    await startActiveSession({ zone, playerToken: seated.token });

    // The bystander has no session of their own, so nothing syncs for them.
    expect((await as(bystander.token).get("/api/smartsync/config/Valorant")).status).toBe(400);
    const upload = await as(bystander.token).post("/api/smartsync/config/Valorant").send({
      payload: "{}",
      paths: ["Config/GameUserSettings.ini"],
      baseVersion: 0,
    });
    expect(upload.status).toBe(400);
  });
});
