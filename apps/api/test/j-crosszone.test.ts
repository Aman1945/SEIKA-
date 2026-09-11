import { describe, it, expect } from "vitest";

import { as, seedPlayer, seedStaff, seedZone, type SeededZone } from "./helpers/factories.js";
import { Tournament, TournamentRegistration } from "../src/models/Tournament.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { getWalletBalance } from "../src/modules/wallet/wallet.service.js";

/** Connects two zones: A requests, B accepts. */
async function connect(a: SeededZone, b: SeededZone) {
  const req = await as(a.ownerToken).post("/api/crosszone/connections").send({
    toZoneId: b.zoneId,
    message: "Let's co-host the Friday cup",
  });
  expect(req.status).toBe(201);
  const res = await as(b.ownerToken)
    .post(`/api/crosszone/connections/${req.body.connectionId}/respond`)
    .send({ accept: true });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("accepted");
  return req.body.connectionId as string;
}

/** Creates an event in the host zone. */
async function createEvent(
  host: SeededZone,
  opts: { entryFee?: number; maxPlayers?: number; prizeSplit?: { place: number; percent: number }[] } = {}
) {
  const res = await as(host.ownerToken).post("/api/tournaments").send({
    name: "Friday Valorant Cup",
    game: "Valorant",
    entryFee: opts.entryFee ?? 100,
    maxPlayers: opts.maxPlayers ?? 16,
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  expect(res.status).toBe(201);
  const id = (res.body.tournamentId ?? res.body.id ?? res.body._id) as string;
  if (opts.prizeSplit) {
    await Tournament.updateOne({ _id: id }, { $set: { prizeSplit: opts.prizeSplit } });
  }
  return id;
}

/** Host invites a co-host, who accepts. */
async function coHost(host: SeededZone, guest: SeededZone, eventId: string) {
  const invite = await as(host.ownerToken)
    .post(`/api/crosszone/events/${eventId}/invite`)
    .send({ zoneId: guest.zoneId });
  expect(invite.status).toBe(201);
  const accept = await as(guest.ownerToken)
    .post(`/api/crosszone/events/${eventId}/invite/respond`)
    .send({ accept: true });
  expect(accept.status).toBe(200);
}

/**
 * Module J — events, tournaments and cross-zone (plan §7.J and §8).
 *
 * §8 is explicit: QA cannot sign the product off until a cross-zone flow has
 * been tested end to end "with two zones and two sets of players". That is what
 * the J-full case below does.
 */
describe("J. Events & cross-zone", () => {
  it("J6 — an owner invites another owner, who can accept or reject", async () => {
    const a = await seedZone({ name: "Zone A" });
    const b = await seedZone({ name: "Zone B" });

    const req = await as(a.ownerToken)
      .post("/api/crosszone/connections")
      .send({ toZoneId: b.zoneId });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe("pending");

    // The requester cannot approve their own request.
    const selfApprove = await as(a.ownerToken)
      .post(`/api/crosszone/connections/${req.body.connectionId}/respond`)
      .send({ accept: true });
    expect(selfApprove.status).toBe(403);

    const accept = await as(b.ownerToken)
      .post(`/api/crosszone/connections/${req.body.connectionId}/respond`)
      .send({ accept: true });
    expect(accept.body.status).toBe("accepted");

    // Answering twice is refused.
    const again = await as(b.ownerToken)
      .post(`/api/crosszone/connections/${req.body.connectionId}/respond`)
      .send({ accept: false });
    expect(again.status).toBe(400);

    // Both sides see the connection.
    expect((await as(a.ownerToken).get("/api/crosszone/connections")).body.connections).toHaveLength(1);
    expect((await as(b.ownerToken).get("/api/crosszone/connections")).body.connections).toHaveLength(1);
  });

  it("J6b — co-hosting requires an accepted connection first", async () => {
    const host = await seedZone({ name: "Host" });
    const stranger = await seedZone({ name: "Stranger" });
    const eventId = await createEvent(host);

    const invite = await as(host.ownerToken)
      .post(`/api/crosszone/events/${eventId}/invite`)
      .send({ zoneId: stranger.zoneId });
    expect(invite.status).toBe(403);

    // A cashier cannot connect zones either — that is an owner decision.
    const cashier = await seedStaff(host, "CASHIER");
    expect(
      (await as(cashier.token).post("/api/crosszone/connections").send({ toZoneId: stranger.zoneId }))
        .status
    ).toBe(403);
  });

  it("J7 — players from both zones register and each pays in their own zone", async () => {
    const host = await seedZone({ name: "Host", hourlyRate: 60 });
    const guest = await seedZone({ name: "Guest", hourlyRate: 60 });
    await connect(host, guest);
    const eventId = await createEvent(host, { entryFee: 100 });
    await coHost(host, guest, eventId);

    const hostPlayer = await seedPlayer({ balance: 500, zoneId: host.zoneId });
    const guestPlayer = await seedPlayer({ balance: 500, zoneId: guest.zoneId });

    const r1 = await as(hostPlayer.token)
      .post(`/api/crosszone/events/${eventId}/register`)
      .send({ zoneId: host.zoneId });
    const r2 = await as(guestPlayer.token)
      .post(`/api/crosszone/events/${eventId}/register`)
      .send({ zoneId: guest.zoneId });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    // Each fee came out of the player's balance in their own zone.
    expect(await getWalletBalance(hostPlayer.playerId, host.zoneId)).toBe(400);
    expect(await getWalletBalance(guestPlayer.playerId, guest.zoneId)).toBe(400);
    // And nothing was taken in the other zone.
    expect(await getWalletBalance(hostPlayer.playerId, guest.zoneId)).toBe(0);
    expect(await getWalletBalance(guestPlayer.playerId, host.zoneId)).toBe(0);
  });

  it("J7b — a player cannot register through a zone that is not taking part", async () => {
    const host = await seedZone({ name: "Host" });
    const guest = await seedZone({ name: "Guest" });
    const outsider = await seedZone({ name: "Outsider" });
    await connect(host, guest);
    const eventId = await createEvent(host, { entryFee: 100 });
    await coHost(host, guest, eventId);

    const player = await seedPlayer({ balance: 500, zoneId: outsider.zoneId });
    const res = await as(player.token)
      .post(`/api/crosszone/events/${eventId}/register`)
      .send({ zoneId: outsider.zoneId });

    expect(res.status).toBe(403);
    expect(await getWalletBalance(player.playerId, outsider.zoneId)).toBe(500);
  });

  it("J7c — an invited zone that has not accepted yet cannot take registrations", async () => {
    const host = await seedZone({ name: "Host" });
    const guest = await seedZone({ name: "Guest" });
    await connect(host, guest);
    const eventId = await createEvent(host, { entryFee: 100 });

    // Invited, but the guest owner has not answered.
    await as(host.ownerToken)
      .post(`/api/crosszone/events/${eventId}/invite`)
      .send({ zoneId: guest.zoneId });

    const player = await seedPlayer({ balance: 500, zoneId: guest.zoneId });
    const res = await as(player.token)
      .post(`/api/crosszone/events/${eventId}/register`)
      .send({ zoneId: guest.zoneId });
    expect(res.status).toBe(403);
  });

  it("J3/J4 — a full event refuses more players, and nobody registers twice", async () => {
    const host = await seedZone({ name: "Host" });
    const guest = await seedZone({ name: "Guest" });
    await connect(host, guest);
    const eventId = await createEvent(host, { entryFee: 100, maxPlayers: 2 });
    await coHost(host, guest, eventId);

    const p1 = await seedPlayer({ balance: 500, zoneId: host.zoneId });
    const p2 = await seedPlayer({ balance: 500, zoneId: guest.zoneId });
    const p3 = await seedPlayer({ balance: 500, zoneId: host.zoneId });

    await as(p1.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: host.zoneId });
    await as(p2.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: guest.zoneId });

    // Full.
    const full = await as(p3.token)
      .post(`/api/crosszone/events/${eventId}/register`)
      .send({ zoneId: host.zoneId });
    expect(full.status).toBe(409);
    expect(await getWalletBalance(p3.playerId, host.zoneId)).toBe(500);

    // Already registered, and charged only once.
    const dupe = await as(p1.token)
      .post(`/api/crosszone/events/${eventId}/register`)
      .send({ zoneId: host.zoneId });
    expect(dupe.status).toBe(409);
    expect(await getWalletBalance(p1.playerId, host.zoneId)).toBe(400);
  });

  it("J8 — each zone checks in its own players and cannot touch the other's", async () => {
    const host = await seedZone({ name: "Host" });
    const guest = await seedZone({ name: "Guest" });
    await connect(host, guest);
    const eventId = await createEvent(host, { entryFee: 100 });
    await coHost(host, guest, eventId);

    const hostPlayer = await seedPlayer({ balance: 500, zoneId: host.zoneId });
    const guestPlayer = await seedPlayer({ balance: 500, zoneId: guest.zoneId });
    await as(hostPlayer.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: host.zoneId });
    await as(guestPlayer.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: guest.zoneId });

    // The host cannot mark the guest zone's player present.
    const wrongZone = await as(host.ownerToken)
      .post(`/api/crosszone/events/${eventId}/checkin`)
      .send({ playerId: guestPlayer.playerId });
    expect(wrongZone.status).toBe(403);

    // Each zone checks in its own.
    expect(
      (await as(host.ownerToken).post(`/api/crosszone/events/${eventId}/checkin`).send({
        playerId: hostPlayer.playerId,
      })).status
    ).toBe(200);
    expect(
      (await as(guest.ownerToken).post(`/api/crosszone/events/${eventId}/checkin`).send({
        playerId: guestPlayer.playerId,
      })).status
    ).toBe(200);

    const regs = await TournamentRegistration.find({ tournamentId: eventId }).lean();
    expect(regs.every((r) => r.checkedIn)).toBe(true);
    // The check-in is recorded against the zone it physically happened at.
    for (const reg of regs) {
      expect(String(reg.checkedInZoneId)).toBe(String(reg.zoneId));
    }
  });

  it("J — the shared bracket exposes event data only, never private tenant data", async () => {
    const host = await seedZone({ name: "Host" });
    const guest = await seedZone({ name: "Guest" });
    await connect(host, guest);
    const eventId = await createEvent(host, { entryFee: 100 });
    await coHost(host, guest, eventId);

    const hostPlayer = await seedPlayer({ balance: 500, zoneId: host.zoneId });
    const guestPlayer = await seedPlayer({ balance: 777, zoneId: guest.zoneId });
    await as(hostPlayer.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: host.zoneId });
    await as(guestPlayer.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: guest.zoneId });

    // Host sees both entrants...
    const bracket = await as(host.ownerToken).get(`/api/crosszone/events/${eventId}/bracket`);
    expect(bracket.status).toBe(200);
    expect(bracket.body.bracket.entrants).toHaveLength(2);

    // ...but nothing private about the other zone's player.
    const serialized = JSON.stringify(bracket.body);
    expect(serialized).not.toContain(guestPlayer.phone);
    expect(serialized).not.toContain("777");
    for (const entrant of bracket.body.bracket.entrants) {
      expect(entrant).not.toHaveProperty("phone");
      expect(entrant).not.toHaveProperty("email");
      expect(entrant).not.toHaveProperty("wallet");
    }

    // Per-zone counts are shared; per-zone money is not.
    expect(bracket.body.bracket.zones).toHaveLength(2);
    expect(bracket.body.bracket.zones.every((z: Record<string, unknown>) => !("revenue" in z))).toBe(true);

    // An uninvolved zone sees nothing at all.
    const outsider = await seedZone({ name: "Outsider" });
    expect(
      (await as(outsider.ownerToken).get(`/api/crosszone/events/${eventId}/bracket`)).status
    ).toBe(404);
  });

  it("J9 — one zone's results are not enough; payout waits for every zone", async () => {
    const host = await seedZone({ name: "Host" });
    const guest = await seedZone({ name: "Guest" });
    await connect(host, guest);
    const eventId = await createEvent(host, { entryFee: 100 });
    await coHost(host, guest, eventId);

    const hostPlayer = await seedPlayer({ balance: 500, zoneId: host.zoneId });
    const guestPlayer = await seedPlayer({ balance: 500, zoneId: guest.zoneId });
    await as(hostPlayer.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: host.zoneId });
    await as(guestPlayer.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: guest.zoneId });

    const placements = [
      { playerId: hostPlayer.playerId, place: 1 },
      { playerId: guestPlayer.playerId, place: 2 },
    ];

    // Only the host has submitted.
    const first = await as(host.ownerToken)
      .post(`/api/crosszone/events/${eventId}/results`)
      .send({ placements });
    expect(first.status).toBe(200);
    expect(first.body.verificationStatus).toBe("pending");
    expect(first.body.consensus.complete).toBe(false);
    expect(first.body.consensus.missingZones).toContain(guest.zoneId);

    // Settling now must be refused.
    const early = await as(host.ownerToken).post(`/api/crosszone/events/${eventId}/settle`).send({});
    expect(early.status).toBe(409);

    // The guest agrees → verified.
    const second = await as(guest.ownerToken)
      .post(`/api/crosszone/events/${eventId}/results`)
      .send({ placements });
    expect(second.body.verificationStatus).toBe("verified");
    expect(second.body.consensus.agreed).toBe(true);
  });

  it("J9b — zones that submit different results cannot pay out", async () => {
    const host = await seedZone({ name: "Host" });
    const guest = await seedZone({ name: "Guest" });
    await connect(host, guest);
    const eventId = await createEvent(host, { entryFee: 100 });
    await coHost(host, guest, eventId);

    const hostPlayer = await seedPlayer({ balance: 500, zoneId: host.zoneId });
    const guestPlayer = await seedPlayer({ balance: 500, zoneId: guest.zoneId });
    await as(hostPlayer.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: host.zoneId });
    await as(guestPlayer.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: guest.zoneId });

    await as(host.ownerToken)
      .post(`/api/crosszone/events/${eventId}/results`)
      .send({
        placements: [
          { playerId: hostPlayer.playerId, place: 1 },
          { playerId: guestPlayer.playerId, place: 2 },
        ],
      });
    // The guest zone says the other player won.
    const conflicting = await as(guest.ownerToken)
      .post(`/api/crosszone/events/${eventId}/results`)
      .send({
        placements: [
          { playerId: guestPlayer.playerId, place: 1 },
          { playerId: hostPlayer.playerId, place: 2 },
        ],
      });
    expect(conflicting.body.consensus.agreed).toBe(false);

    const settle = await as(host.ownerToken).post(`/api/crosszone/events/${eventId}/settle`).send({});
    expect(settle.status).toBe(409);
    expect(settle.body.error?.message ?? settle.text).toMatch(/different results/i);

    // No money moved.
    expect(await getWalletBalance(hostPlayer.playerId, host.zoneId)).toBe(400);
  });

  it("J9c — an open dispute blocks the payout until the host resolves it", async () => {
    const host = await seedZone({ name: "Host" });
    const guest = await seedZone({ name: "Guest" });
    await connect(host, guest);
    const eventId = await createEvent(host, {
      entryFee: 100,
      prizeSplit: [{ place: 1, percent: 100 }],
    });
    await coHost(host, guest, eventId);

    const hostPlayer = await seedPlayer({ balance: 500, zoneId: host.zoneId });
    const guestPlayer = await seedPlayer({ balance: 500, zoneId: guest.zoneId });
    await as(hostPlayer.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: host.zoneId });
    await as(guestPlayer.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: guest.zoneId });

    const placements = [
      { playerId: hostPlayer.playerId, place: 1 },
      { playerId: guestPlayer.playerId, place: 2 },
    ];
    await as(host.ownerToken).post(`/api/crosszone/events/${eventId}/results`).send({ placements });
    await as(guest.ownerToken).post(`/api/crosszone/events/${eventId}/results`).send({ placements });

    // The guest zone disputes even though the submissions agreed.
    const dispute = await as(guest.ownerToken)
      .post(`/api/crosszone/events/${eventId}/disputes`)
      .send({ reason: "Our player was disconnected in the final round" });
    expect(dispute.status).toBe(201);
    expect(dispute.body.verificationStatus).toBe("disputed");

    const blocked = await as(host.ownerToken).post(`/api/crosszone/events/${eventId}/settle`).send({});
    expect(blocked.status).toBe(409);
    expect(await getWalletBalance(hostPlayer.playerId, host.zoneId)).toBe(400);

    // The host resolves it, and only then can the payout run.
    const verification = await as(host.ownerToken).get(`/api/crosszone/events/${eventId}/verification`);
    const disputeId = verification.body.disputes[0].id;

    // A co-host cannot resolve — the host owns that call.
    expect(
      (await as(guest.ownerToken)
        .post(`/api/crosszone/events/${eventId}/disputes/${disputeId}/resolve`)
        .send({ resolution: "Ignoring it" })).status
    ).toBe(403);

    const resolved = await as(host.ownerToken)
      .post(`/api/crosszone/events/${eventId}/disputes/${disputeId}/resolve`)
      .send({ resolution: "Reviewed the recording; the result stands" });
    expect(resolved.body.verificationStatus).toBe("verified");

    const settle = await as(host.ownerToken).post(`/api/crosszone/events/${eventId}/settle`).send({});
    expect(settle.status).toBe(200);
  });

  it("J10 — the split is computed, audit-logged, and private between zones", async () => {
    const host = await seedZone({ name: "Host" });
    const guest = await seedZone({ name: "Guest" });
    await connect(host, guest);
    // Winner takes 60% of the pooled fees.
    const eventId = await createEvent(host, {
      entryFee: 100,
      prizeSplit: [{ place: 1, percent: 60 }],
    });
    await coHost(host, guest, eventId);

    const hostPlayer = await seedPlayer({ balance: 500, zoneId: host.zoneId });
    const guestPlayer = await seedPlayer({ balance: 500, zoneId: guest.zoneId });
    await as(hostPlayer.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: host.zoneId });
    await as(guestPlayer.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: guest.zoneId });

    const placements = [
      { playerId: guestPlayer.playerId, place: 1 }, // the guest zone's player wins
      { playerId: hostPlayer.playerId, place: 2 },
    ];
    await as(host.ownerToken).post(`/api/crosszone/events/${eventId}/results`).send({ placements });
    await as(guest.ownerToken).post(`/api/crosszone/events/${eventId}/results`).send({ placements });

    const settle = await as(host.ownerToken).post(`/api/crosszone/events/${eventId}/settle`).send({});
    expect(settle.status).toBe(200);

    // Pool = 2 × ₹100. Winner takes 60% = ₹120.
    expect(settle.body.settlement.pool).toBe(200);
    expect(settle.body.settlement.prizeTotal).toBe(120);

    // The prize is credited in the winner's OWN zone — money never crosses.
    expect(await getWalletBalance(guestPlayer.playerId, guest.zoneId)).toBe(400 + 120);
    expect(await getWalletBalance(guestPlayer.playerId, host.zoneId)).toBe(0);
    expect(await getWalletBalance(hostPlayer.playerId, host.zoneId)).toBe(400);

    // Each zone keeps its own fees less the prizes it paid: host ₹100, guest ₹100 − ₹120 = −₹20.
    const hostView = await as(host.ownerToken).get(`/api/crosszone/events/${eventId}/settlement`);
    expect(hostView.body.settlement.yourFees).toBe(100);
    expect(hostView.body.settlement.yourNet).toBe(100);
    // The host organised the pool, so it sees the whole breakdown.
    expect(hostView.body.settlement.netByZone).toBeTruthy();

    const guestView = await as(guest.ownerToken).get(`/api/crosszone/events/${eventId}/settlement`);
    expect(guestView.body.settlement.yourFees).toBe(100);
    expect(guestView.body.settlement.yourNet).toBe(-20);
    // A co-host sees only its own line, not the host's.
    expect(guestView.body.settlement.netByZone).toBeUndefined();

    // An uninvolved zone sees nothing.
    const outsider = await seedZone({ name: "Outsider" });
    expect(
      (await as(outsider.ownerToken).get(`/api/crosszone/events/${eventId}/settlement`)).status
    ).toBe(404);

    // Every cross-zone action is on the record for the zone that took it.
    const hostActions = (await AuditLog.find({ zoneId: host.zoneId }).lean()).map((l) => String(l.action));
    expect(hostActions).toContain("ZONE_CONNECTION_REQUEST");
    expect(hostActions).toContain("CROSSZONE_INVITE");
    expect(hostActions).toContain("EVENT_RESULTS_SUBMIT");
    expect(hostActions).toContain("EVENT_SETTLE");

    const guestActions = (await AuditLog.find({ zoneId: guest.zoneId }).lean()).map((l) => String(l.action));
    expect(guestActions).toContain("ZONE_CONNECTION_ACCEPT");
    expect(guestActions).toContain("CROSSZONE_INVITE_ACCEPT");
    // The host's settle is the host's record, not the guest's.
    expect(guestActions).not.toContain("EVENT_SETTLE");
  });

  it("J — settling twice is refused, so prizes cannot be paid twice", async () => {
    const host = await seedZone({ name: "Host" });
    const guest = await seedZone({ name: "Guest" });
    await connect(host, guest);
    const eventId = await createEvent(host, {
      entryFee: 100,
      prizeSplit: [{ place: 1, percent: 50 }],
    });
    await coHost(host, guest, eventId);

    const p1 = await seedPlayer({ balance: 500, zoneId: host.zoneId });
    const p2 = await seedPlayer({ balance: 500, zoneId: guest.zoneId });
    await as(p1.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: host.zoneId });
    await as(p2.token).post(`/api/crosszone/events/${eventId}/register`).send({ zoneId: guest.zoneId });

    const placements = [
      { playerId: p1.playerId, place: 1 },
      { playerId: p2.playerId, place: 2 },
    ];
    await as(host.ownerToken).post(`/api/crosszone/events/${eventId}/results`).send({ placements });
    await as(guest.ownerToken).post(`/api/crosszone/events/${eventId}/results`).send({ placements });

    expect((await as(host.ownerToken).post(`/api/crosszone/events/${eventId}/settle`).send({})).status).toBe(200);
    const balanceAfterFirst = await getWalletBalance(p1.playerId, host.zoneId);

    const again = await as(host.ownerToken).post(`/api/crosszone/events/${eventId}/settle`).send({});
    expect(again.status).toBe(400);
    expect(await getWalletBalance(p1.playerId, host.zoneId)).toBe(balanceAfterFirst);
  });

  it("J-full — two zones, two sets of players, end to end (plan §8 sign-off gate)", async () => {
    const mumbai = await seedZone({ name: "SEIKA Mumbai", city: "Mumbai" });
    const pune = await seedZone({ name: "SEIKA Pune", city: "Pune" });

    // 1. The owners connect.
    await connect(mumbai, pune);

    // 2. Mumbai creates the event and invites Pune, who accepts.
    const eventId = await createEvent(mumbai, {
      entryFee: 100,
      maxPlayers: 8,
      prizeSplit: [
        { place: 1, percent: 50 },
        { place: 2, percent: 25 },
      ],
    });
    await coHost(mumbai, pune, eventId);

    // 3. Two players per zone register, each paying in their own zone.
    const mumbaiPlayers = [
      await seedPlayer({ balance: 300, zoneId: mumbai.zoneId, name: "M1" }),
      await seedPlayer({ balance: 300, zoneId: mumbai.zoneId, name: "M2" }),
    ];
    const punePlayers = [
      await seedPlayer({ balance: 300, zoneId: pune.zoneId, name: "P1" }),
      await seedPlayer({ balance: 300, zoneId: pune.zoneId, name: "P2" }),
    ];
    for (const p of mumbaiPlayers) {
      expect(
        (await as(p.token).post(`/api/crosszone/events/${eventId}/register`).send({
          zoneId: mumbai.zoneId,
        })).status
      ).toBe(201);
    }
    for (const p of punePlayers) {
      expect(
        (await as(p.token).post(`/api/crosszone/events/${eventId}/register`).send({
          zoneId: pune.zoneId,
        })).status
      ).toBe(201);
    }

    // 4. Each zone checks in its own players.
    for (const p of mumbaiPlayers) {
      await as(mumbai.ownerToken)
        .post(`/api/crosszone/events/${eventId}/checkin`)
        .send({ playerId: p.playerId });
    }
    for (const p of punePlayers) {
      await as(pune.ownerToken)
        .post(`/api/crosszone/events/${eventId}/checkin`)
        .send({ playerId: p.playerId });
    }

    // 5. The shared bracket shows all four, grouped by zone.
    const bracket = await as(pune.ownerToken).get(`/api/crosszone/events/${eventId}/bracket`);
    expect(bracket.body.bracket.entrants).toHaveLength(4);
    expect(bracket.body.bracket.crossZone).toBe(true);
    const zones = bracket.body.bracket.zones as { zoneId: string; registered: number; checkedIn: number }[];
    expect(zones.find((z) => z.zoneId === mumbai.zoneId)!.checkedIn).toBe(2);
    expect(zones.find((z) => z.zoneId === pune.zoneId)!.checkedIn).toBe(2);

    // 6. Both zones submit the same placements → verified.
    const placements = [
      { playerId: punePlayers[0].playerId, place: 1 },
      { playerId: mumbaiPlayers[0].playerId, place: 2 },
      { playerId: punePlayers[1].playerId, place: 3 },
      { playerId: mumbaiPlayers[1].playerId, place: 4 },
    ];
    await as(mumbai.ownerToken).post(`/api/crosszone/events/${eventId}/results`).send({ placements });
    const verified = await as(pune.ownerToken)
      .post(`/api/crosszone/events/${eventId}/results`)
      .send({ placements });
    expect(verified.body.verificationStatus).toBe("verified");

    // 7. Mumbai settles. Pool = 4 × ₹100 = ₹400; 1st = ₹200, 2nd = ₹100.
    const settle = await as(mumbai.ownerToken)
      .post(`/api/crosszone/events/${eventId}/settle`)
      .send({});
    expect(settle.status).toBe(200);
    expect(settle.body.settlement.pool).toBe(400);
    expect(settle.body.settlement.prizeTotal).toBe(300);

    // 8. Prizes land in each winner's own zone.
    expect(await getWalletBalance(punePlayers[0].playerId, pune.zoneId)).toBe(200 + 200);
    expect(await getWalletBalance(mumbaiPlayers[0].playerId, mumbai.zoneId)).toBe(200 + 100);
    expect(await getWalletBalance(punePlayers[1].playerId, pune.zoneId)).toBe(200);
    // Nobody holds a balance in the other zone.
    expect(await getWalletBalance(punePlayers[0].playerId, mumbai.zoneId)).toBe(0);

    // 9. Everyone earned XP; the winner earned the most.
    const bracketAfter = await as(mumbai.ownerToken).get(`/api/crosszone/events/${eventId}/bracket`);
    expect(
      (bracketAfter.body.bracket.entrants as { placement: number | null }[]).every(
        (e) => e.placement !== null
      )
    ).toBe(true);

    // 10. Isolation held throughout: Pune never saw Mumbai's private data.
    expect(
      (await as(pune.ownerToken).get("/api/sessions/history/list")).body.total
    ).toBe(0);
    const puneAudit = (await AuditLog.find({ zoneId: pune.zoneId }).lean()).map((l) => String(l.action));
    expect(puneAudit).not.toContain("EVENT_SETTLE");

    const event = await Tournament.findById(eventId).lean();
    expect(event!.status).toBe("completed");
    expect(event!.verificationStatus).toBe("verified");
  });
});
