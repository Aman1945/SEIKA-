import { describe, it, expect } from "vitest";

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
import { WalletLedger } from "../src/models/WalletLedger.js";

/**
 * Module C — top-up + hour selection (plan §7.C). All P0 except C7/C8.
 * Rate is ₹60/hour in these cases, so 1h = ₹60, 2h = ₹120, 3h = ₹180.
 */
describe("C. Top-up + hour selection", () => {
  it("C1 — a cashier cash top-up credits the ledger and shows in the balance", async () => {
    const zone = await seedZone();
    const cashier = await seedStaff(zone, "CASHIER");
    const player = await seedPlayer({ zoneId: zone.zoneId });

    const res = await as(cashier.token)
      .post("/api/wallet/topup")
      .send({ playerId: player.playerId, amount: 500, method: "CASH" });

    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(500);

    const ledger = await WalletLedger.find({ playerId: player.playerId }).lean();
    expect(ledger).toHaveLength(1);
    expect(parseFloat(String(ledger[0].amount))).toBe(500);
    expect(ledger[0].type).toBe("TOPUP");
  });

  it("C3 — 1h fixed block requires the full hour's cost up front", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 60, zoneId: zone.zoneId });

    const attach = await as(player.token)
      .post("/api/sessions/attach")
      .send({ qrToken: qrFor(zone.pcId) });
    const res = await as(player.token)
      .post(`/api/sessions/${attach.body.sessionId}/authorize`)
      .send({ source: "WALLET", sessionMode: "FIXED_DURATION", selectedMinutes: 60 });

    expect(res.status).toBe(200);
    expect(res.body.minStartAmount).toBe(60);

    const session = await Session.findById(attach.body.sessionId).lean();
    expect(session!.sessionMode).toBe("FIXED_DURATION");
    expect(session!.selectedMinutes).toBe(60);
  });

  it("C4 — 2h freezes the block cost in pricingSnapshot and bills the block", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });

    const sessionId = await startActiveSession({
      zone,
      playerToken: player.token,
      sessionMode: "FIXED_DURATION",
      selectedMinutes: 120,
    });

    const before = await Session.findById(sessionId).lean();
    const snapshot = before!.pricingSnapshot as Record<string, unknown>;
    expect(snapshot.hourlyRate).toBe(60);
    expect(snapshot.selectedMinutes).toBe(120);
    expect(snapshot.minimumStartBalance).toBe(120);

    await backdateSessionStart(sessionId, 120);
    const end = await as(player.token).post(`/api/sessions/${sessionId}/end`).send({});
    expect(end.status).toBe(200);
    // Billed the 2h block: 300 − 120 = 180.
    expect(end.body.cost).toBe(120);

    const balance = await as(player.token).get(`/api/wallet/${player.playerId}/balance`);
    expect(balance.body.balance).toBe(180);
  });

  it("C5 — 3h block cost is required before confirmation", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    // ₹150 < ₹180 needed for 3h.
    const player = await seedPlayer({ balance: 150, zoneId: zone.zoneId });

    const attach = await as(player.token)
      .post("/api/sessions/attach")
      .send({ qrToken: qrFor(zone.pcId) });
    const res = await as(player.token)
      .post(`/api/sessions/${attach.body.sessionId}/authorize`)
      .send({ source: "WALLET", sessionMode: "FIXED_DURATION", selectedMinutes: 180 });

    expect(res.status).toBe(402);
    expect(res.body.reason).toBe("INSUFFICIENT_BALANCE");
    expect(res.body.minStartAmount).toBe(180);
  });

  it("C — a fixed block must be exactly 1h, 2h or 3h", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 1000, zoneId: zone.zoneId });

    const attach = await as(player.token)
      .post("/api/sessions/attach")
      .send({ qrToken: qrFor(zone.pcId) });

    for (const minutes of [45, 90, 240]) {
      const res = await as(player.token)
        .post(`/api/sessions/${attach.body.sessionId}/authorize`)
        .send({ source: "WALLET", sessionMode: "FIXED_DURATION", selectedMinutes: minutes });
      expect(res.status).toBe(400);
    }

    // And omitting the field entirely is refused too.
    const missing = await as(player.token)
      .post(`/api/sessions/${attach.body.sessionId}/authorize`)
      .send({ source: "WALLET", sessionMode: "FIXED_DURATION" });
    expect(missing.status).toBe(400);
  });

  it("C6 — Open Hour needs a minimum deposit and then meters actual minutes", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    // Minimum start = 15 min of play = ₹15.
    const player = await seedPlayer({ balance: 100, zoneId: zone.zoneId });

    const sessionId = await startActiveSession({
      zone,
      playerToken: player.token,
      sessionMode: "OPEN_HOUR",
    });

    const session = await Session.findById(sessionId).lean();
    expect(session!.sessionMode).toBe("OPEN_HOUR");
    expect(session!.selectedMinutes ?? null).toBeNull();
    expect((session!.pricingSnapshot as Record<string, number>).minimumStartBalance).toBe(15);

    // 30 minutes metered at ₹60/h = ₹30.
    await backdateSessionStart(sessionId, 30);
    const end = await as(player.token).post(`/api/sessions/${sessionId}/end`).send({});
    expect(end.body.cost).toBe(30);
    expect(end.body.validMinutes).toBe(30);
  });

  it("C6b — Open Hour below the minimum deposit is refused and the PC stays locked", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 5, zoneId: zone.zoneId }); // < ₹15

    const attach = await as(player.token)
      .post("/api/sessions/attach")
      .send({ qrToken: qrFor(zone.pcId) });
    const res = await as(player.token)
      .post(`/api/sessions/${attach.body.sessionId}/authorize`)
      .send({ source: "WALLET", sessionMode: "OPEN_HOUR" });

    expect(res.status).toBe(402);
    expect(res.body.minStartAmount).toBe(15);
    const session = await Session.findById(attach.body.sessionId).lean();
    expect(session!.status).toBe("PENDING_AUTH");
  });

  it("C8 — a fixed block ended early still bills the whole block and records why", async () => {
    const zone = await seedZone({ hourlyRate: 60 });
    const player = await seedPlayer({ balance: 300, zoneId: zone.zoneId });

    const sessionId = await startActiveSession({
      zone,
      playerToken: player.token,
      sessionMode: "FIXED_DURATION",
      selectedMinutes: 120,
    });
    // Ends after only 20 of the 120 booked minutes.
    await backdateSessionStart(sessionId, 20);

    const end = await as(player.token).post(`/api/sessions/${sessionId}/end`).send({});
    expect(end.status).toBe(200);
    // Policy: the block is charged in full.
    expect(end.body.cost).toBe(120);

    const session = await Session.findById(sessionId).lean();
    expect(session!.endReason).toBeTruthy();
  });
});
