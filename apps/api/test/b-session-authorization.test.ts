import { describe, it, expect } from "vitest";
import mongoose from "mongoose";

import {
  as,
  backdateSessionStart,
  qrFor,
  seedPlayer,
  seedStaff,
  seedZone,
  startActiveSession,
} from "./helpers/factories.js";
import { Session } from "../src/models/Session.js";
import { PC } from "../src/models/PC.js";
import { Zone } from "../src/models/Zone.js";
import { Voucher } from "../src/models/Voucher.js";
import { PlayerPackage } from "../src/models/PlayerPackage.js";
import { Player } from "../src/models/Player.js";

/**
 * Module B — PC kiosk + session authorization (plan §7.B). This is the module
 * that protects the product's single most important rule: **a QR scan
 * identifies a player, it never unlocks a PC.**
 */
describe("B. PC kiosk & session authorization", () => {
  it("B1 — QR scan attaches the player but leaves the PC locked with 0 XP", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId }); // deliberately unfunded

    const attach = await as(player.token)
      .post("/api/sessions/attach")
      .send({ qrToken: qrFor(zone.pcId) });

    expect(attach.status).toBe(201);
    expect(attach.body.status).toBe("PENDING_AUTH");

    const session = await Session.findById(attach.body.sessionId).lean();
    expect(session!.status).toBe("PENDING_AUTH");
    expect(session!.xpAwarded).toBe(0);
    expect(session!.startTime ?? null).toBeNull();

    // And the XP ledger for the player is untouched.
    const p = await Player.findById(player.playerId).lean();
    expect(p!.xpTotal).toBe(0);
  });

  it("B2 — a funded wallet authorizes, unlocks the PC and starts the timer", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 200, zoneId: zone.zoneId });

    const sessionId = await startActiveSession({ zone, playerToken: player.token });

    const session = await Session.findById(sessionId).lean();
    expect(session!.status).toBe("ACTIVE");
    expect(session!.paymentSource).toBe("WALLET");
    expect(session!.startTime).toBeTruthy();
  });

  it("B3 — insufficient balance blocks the start and the PC stays locked", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 5, zoneId: zone.zoneId });

    const attach = await as(player.token)
      .post("/api/sessions/attach")
      .send({ qrToken: qrFor(zone.pcId) });
    const sessionId = attach.body.sessionId;

    const authRes = await as(player.token)
      .post(`/api/sessions/${sessionId}/authorize`)
      .send({ source: "WALLET" });

    expect(authRes.status).toBe(402);
    expect(authRes.body.reason).toBe("INSUFFICIENT_BALANCE");
    // The response must tell the player what they need, so the app can offer a top-up.
    expect(authRes.body.minStartAmount).toBeGreaterThan(0);

    const session = await Session.findById(sessionId).lean();
    expect(session!.status).toBe("PENDING_AUTH");
  });

  it("B4 — cash source requires a cashier; a player cannot self-approve", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });
    const cashier = await seedStaff(zone, "CASHIER");

    const attach = await as(player.token)
      .post("/api/sessions/attach")
      .send({ qrToken: qrFor(zone.pcId) });
    const sessionId = attach.body.sessionId;

    // Player claiming CASH must be refused.
    const selfApprove = await as(player.token)
      .post(`/api/sessions/${sessionId}/authorize`)
      .send({ source: "CASH" });
    expect(selfApprove.status).toBe(403);

    // Cashier approval authorizes it.
    const staffApprove = await as(cashier.token)
      .post(`/api/sessions/${sessionId}/authorize`)
      .send({ source: "CASH" });
    expect(staffApprove.status).toBe(200);
    expect(staffApprove.body.authorized).toBe(true);
  });

  it("B5 — package authorization deducts package minutes and leaves the wallet alone", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });

    await PlayerPackage.create({
      playerId: new mongoose.Types.ObjectId(player.playerId),
      zoneId: new mongoose.Types.ObjectId(zone.zoneId),
      minutesRemaining: 120,
      active: true,
      source: "granted",
    });

    const sessionId = await startActiveSession({
      zone,
      playerToken: player.token,
      source: "PACKAGE",
    });
    await backdateSessionStart(sessionId, 60);

    const end = await as(player.token).post(`/api/sessions/${sessionId}/end`).send({});
    expect(end.status).toBe(200);

    const pkg = await PlayerPackage.findOne({ playerId: player.playerId }).lean();
    expect(pkg!.minutesRemaining).toBeLessThanOrEqual(60);

    // Wallet untouched — the package paid for the play.
    const balance = await as(player.token).get(`/api/wallet/${player.playerId}/balance`);
    expect(balance.body.balance).toBe(300);
  });

  it("B6 — a valid single-use voucher authorizes once, then is exhausted", async () => {
    const zone = await seedZone();
    const playerA = await seedPlayer({ zoneId: zone.zoneId });
    const playerB = await seedPlayer({ zoneId: zone.zoneId });

    await Voucher.create({
      zoneId: new mongoose.Types.ObjectId(zone.zoneId),
      code: "FREEPLAY1",
      type: "FREE_MINUTES",
      value: 60,
      maxRedemptions: 1,
      redeemed: 0,
      active: true,
    });

    const first = await startActiveSession({
      zone,
      playerToken: playerA.token,
      source: "VOUCHER",
      voucherCode: "FREEPLAY1",
    });
    expect(first).toBeTruthy();

    // Second player, same one-use code → refused.
    const pcB = await PC.create({
      zoneId: new mongoose.Types.ObjectId(zone.zoneId),
      branchId: new mongoose.Types.ObjectId(zone.branchId),
      pcNumber: "PC-02",
      hourlyRate: mongoose.Types.Decimal128.fromString("60.00"),
      category: "standard",
      clientKey: `key-${new mongoose.Types.ObjectId()}`,
    });
    const attach = await as(playerB.token)
      .post("/api/sessions/attach")
      .send({ qrToken: qrFor(String(pcB._id)) });
    const res = await as(playerB.token)
      .post(`/api/sessions/${attach.body.sessionId}/authorize`)
      .send({ source: "VOUCHER", voucherCode: "FREEPLAY1" });

    expect(res.status).toBe(402);
    expect(res.body.reason).toContain("VOUCHER");
  });

  it("B7 — postpaid is denied while the zone setting is off, allowed once on", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });
    const cashier = await seedStaff(zone, "CASHIER");

    const attach = await as(player.token)
      .post("/api/sessions/attach")
      .send({ qrToken: qrFor(zone.pcId) });
    const sessionId = attach.body.sessionId;

    const denied = await as(cashier.token)
      .post(`/api/sessions/${sessionId}/authorize`)
      .send({ source: "POSTPAID" });
    expect(denied.status).toBe(402);
    expect(denied.body.reason).toBe("POSTPAID_DISABLED");

    await Zone.updateOne({ _id: zone.zoneId }, { $set: { postpaidEnabled: true } });

    const allowed = await as(cashier.token)
      .post(`/api/sessions/${sessionId}/authorize`)
      .send({ source: "POSTPAID" });
    expect(allowed.status).toBe(200);
  });

  it("B9 — ending a session locks the PC and returns it to the pool", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });

    const sessionId = await startActiveSession({ zone, playerToken: player.token });
    await backdateSessionStart(sessionId, 30);

    const end = await as(player.token).post(`/api/sessions/${sessionId}/end`).send({});
    expect(end.status).toBe(200);

    const session = await Session.findById(sessionId).lean();
    expect(session!.status).toBe("COMPLETED");
    expect(session!.endTime).toBeTruthy();

    const pc = await PC.findById(zone.pcId).lean();
    expect(["AVAILABLE", "CLEANING"]).toContain(String(pc!.status));
  });

  it("B — one PC cannot hold two live sessions at once", async () => {
    const zone = await seedZone();
    const playerA = await seedPlayer({ balance: 300, zoneId: zone.zoneId });
    const playerB = await seedPlayer({ balance: 300, zoneId: zone.zoneId });

    await startActiveSession({ zone, playerToken: playerA.token });

    const attach = await as(playerB.token)
      .post("/api/sessions/attach")
      .send({ qrToken: qrFor(zone.pcId) });
    expect(attach.status).toBe(409);
  });

  it("B — an invalid or tampered QR token cannot attach", async () => {
    const zone = await seedZone();
    const player = await seedPlayer({ zoneId: zone.zoneId });

    const res = await as(player.token)
      .post("/api/sessions/attach")
      .send({ qrToken: "not-a-real-token" });
    expect(res.status).toBe(400);
    expect(await Session.countDocuments({})).toBe(0);
  });
});
