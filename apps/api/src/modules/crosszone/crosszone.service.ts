import mongoose from "mongoose";

import { Tournament, TournamentRegistration } from "../../models/Tournament.js";
import { ZoneConnection, pairKeyFor } from "../../models/ZoneConnection.js";
import { Zone } from "../../models/Zone.js";
import { Player } from "../../models/Player.js";
import { badRequest, conflict, forbidden, notFound } from "../../common/errors.js";
import { withTransaction } from "../../config/db.js";
import { addWalletEntry, getWalletBalance } from "../wallet/wallet.service.js";
import { grantCoins } from "../coin/coin.service.js";
import { notify } from "../notification/notification.service.js";
import { emitToZone } from "../realtime/io.js";

// ─── Owner-to-owner connections ──────────────────────────────────────────────

/** Owner of `fromZoneId` asks the owner of `toZoneId` to connect. */
export async function requestConnection(params: {
  fromZoneId: string;
  toZoneId: string;
  requestedBy: string;
  message?: string;
}) {
  if (params.fromZoneId === params.toZoneId) throw badRequest("A zone cannot connect to itself");
  const target = await Zone.findById(params.toZoneId).select("_id name");
  if (!target) throw notFound("Zone not found");

  const pairKey = pairKeyFor(params.fromZoneId, params.toZoneId);
  const existing = await ZoneConnection.findOne({ pairKey });

  if (existing) {
    if (existing.status === "accepted") throw conflict("These zones are already connected");
    if (existing.status === "pending") throw conflict("A request is already pending for these zones");
    // A rejected or revoked link can be asked for again, as a fresh request.
    existing.set({
      fromZoneId: new mongoose.Types.ObjectId(params.fromZoneId),
      toZoneId: new mongoose.Types.ObjectId(params.toZoneId),
      status: "pending",
      requestedBy: params.requestedBy,
      message: params.message,
      respondedBy: undefined,
      respondedAt: undefined,
    });
    await existing.save();
    return existing;
  }

  return ZoneConnection.create({
    fromZoneId: params.fromZoneId,
    toZoneId: params.toZoneId,
    pairKey,
    status: "pending",
    requestedBy: params.requestedBy,
    message: params.message,
  });
}

/**
 * The invited owner accepts or rejects. Only the zone that *received* the
 * request may answer it — otherwise a requester could approve their own.
 */
export async function respondToConnection(params: {
  connectionId: string;
  zoneId: string;
  accept: boolean;
  respondedBy: string;
}) {
  const conn = await ZoneConnection.findById(params.connectionId);
  if (!conn) throw notFound("Connection request not found");
  if (String(conn.toZoneId) !== params.zoneId) {
    throw forbidden("Only the invited zone can answer this request");
  }
  if (conn.status !== "pending") throw badRequest(`Request is already ${conn.status}`);

  conn.status = params.accept ? "accepted" : "rejected";
  conn.respondedBy = params.respondedBy;
  conn.respondedAt = new Date();
  await conn.save();
  return conn;
}

/** Connections involving a zone, in either direction. */
export async function listConnections(zoneId: string) {
  const id = new mongoose.Types.ObjectId(zoneId);
  return ZoneConnection.find({ $or: [{ fromZoneId: id }, { toZoneId: id }] })
    .sort({ updatedAt: -1 })
    .lean();
}

export async function areZonesConnected(a: string, b: string): Promise<boolean> {
  const conn = await ZoneConnection.findOne({ pairKey: pairKeyFor(a, b), status: "accepted" });
  return Boolean(conn);
}

// ─── Cross-zone event lifecycle ──────────────────────────────────────────────

/**
 * Plain shapes for the pure helpers below. Mongoose's subdocument types are
 * awkward to pass around, so callers narrow to these at the boundary with
 * `asEventShape`.
 */
export interface EventZoneShape {
  zoneId: unknown;
  participatingZones: { zoneId: unknown; status: string }[];
  crossZone?: boolean;
  resultSubmissions: { zoneId: unknown; placements: { playerId: string; place: number }[] }[];
}

/** Narrows a Tournament document (or lean object) to the shape helpers want. */
export function asEventShape(t: unknown): EventZoneShape {
  return t as EventZoneShape;
}

/** The zones that may act on an event: the host plus every accepted co-host. */
export function acceptedZoneIds(t: {
  zoneId: unknown;
  participatingZones: { zoneId: unknown; status: string }[];
}): string[] {
  return [
    String(t.zoneId),
    ...t.participatingZones.filter((p) => p.status === "accepted").map((p) => String(p.zoneId)),
  ];
}

/** Zones involved at all, including those yet to answer their invitation. */
function involvedZoneIds(t: {
  zoneId: unknown;
  participatingZones: { zoneId: unknown }[];
}): string[] {
  return [String(t.zoneId), ...t.participatingZones.map((p) => String(p.zoneId))];
}

function assertInvolved(t: Parameters<typeof involvedZoneIds>[0], zoneId?: string): void {
  if (!zoneId || !involvedZoneIds(t).includes(zoneId)) {
    throw notFound("Event not found");
  }
}

/**
 * Host invites another zone to co-host. Requires an accepted connection, so a
 * zone can never be pulled into an event by a stranger.
 */
export async function inviteZone(params: {
  tournamentId: string;
  hostZoneId: string;
  inviteeZoneId: string;
  actorId: string;
}) {
  const t = await Tournament.findById(params.tournamentId);
  if (!t) throw notFound("Event not found");
  if (String(t.zoneId) !== params.hostZoneId) throw forbidden("Only the host zone can invite");
  if (["completed", "cancelled"].includes(t.status)) throw badRequest(`Event is ${t.status}`);
  if (params.inviteeZoneId === params.hostZoneId) throw badRequest("The host is already involved");

  if (!(await areZonesConnected(params.hostZoneId, params.inviteeZoneId))) {
    throw forbidden("Connect with that zone's owner before inviting them to co-host");
  }
  if (t.participatingZones.some((p) => String(p.zoneId) === params.inviteeZoneId)) {
    throw conflict("That zone is already invited");
  }

  t.participatingZones.push({
    zoneId: new mongoose.Types.ObjectId(params.inviteeZoneId),
    status: "invited",
    invitedAt: new Date(),
  } as unknown as never);
  t.crossZone = true;
  await t.save();

  emitToZone(params.inviteeZoneId, "crosszone:invite", {
    tournamentId: String(t._id),
    name: t.name,
    hostZoneId: params.hostZoneId,
  });
  return t;
}

/** The invited zone accepts or declines co-hosting. */
export async function respondToInvite(params: {
  tournamentId: string;
  zoneId: string;
  accept: boolean;
  actorId: string;
}) {
  const t = await Tournament.findById(params.tournamentId);
  if (!t) throw notFound("Event not found");

  const entry = t.participatingZones.find((p) => String(p.zoneId) === params.zoneId);
  if (!entry) throw notFound("No invitation for this zone");
  if (entry.status !== "invited") throw badRequest(`Invitation already ${entry.status}`);

  entry.status = params.accept ? "accepted" : "declined";
  entry.respondedBy = params.actorId;
  entry.respondedAt = new Date();
  await t.save();

  emitToZone(String(t.zoneId), "crosszone:invite_response", {
    tournamentId: String(t._id),
    zoneId: params.zoneId,
    accepted: params.accept,
  });
  return t;
}

/**
 * Player registers, paying from their wallet **in the zone they register
 * through** (plan J7). For a cross-zone event that zone must be the host or an
 * accepted co-host; the money never leaves the tenant it was paid in.
 */
export async function registerForEvent(params: {
  tournamentId: string;
  playerId: string;
  zoneId: string;
}) {
  const t = await Tournament.findById(params.tournamentId);
  if (!t) throw notFound("Event not found");
  if (!["registration", "upcoming"].includes(t.status)) {
    throw badRequest(`Registration closed (${t.status})`);
  }

  const eligible = acceptedZoneIds(t);
  if (!eligible.includes(params.zoneId)) {
    throw forbidden("That zone is not taking part in this event");
  }

  const count = await TournamentRegistration.countDocuments({ tournamentId: params.tournamentId });
  if (count >= t.maxPlayers) throw conflict("Event full");

  const fee = parseFloat(t.entryFee.toString());
  const paymentStatus = fee > 0 ? "paid" : "free";

  return withTransaction(async (txn) => {
    if (fee > 0) {
      const balance = await getWalletBalance(params.playerId, params.zoneId);
      if (balance < fee) throw badRequest(`Insufficient balance (need ₹${fee}, have ₹${balance})`);
      await addWalletEntry(
        {
          playerId: params.playerId,
          zoneId: params.zoneId,
          amount: -fee,
          type: "BOOKING",
          method: "WALLET",
          reference: `event:${params.tournamentId}`,
          createdBy: params.playerId,
        },
        txn
      );
    }
    try {
      const [reg] = await TournamentRegistration.create(
        [
          {
            tournamentId: params.tournamentId,
            playerId: params.playerId,
            zoneId: params.zoneId,
            paymentStatus,
          },
        ],
        { session: txn }
      );
      return reg;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw conflict("Already registered");
      throw e;
    }
  });
}

/**
 * Staff check a player in at their own zone (plan J8). A zone can only check in
 * players who registered through it — nobody gets to mark another zone's
 * players present.
 */
export async function checkInAtZone(params: {
  tournamentId: string;
  playerId: string;
  zoneId: string;
  actorId: string;
}) {
  const t = await Tournament.findById(params.tournamentId);
  if (!t) throw notFound("Event not found");
  assertInvolved(t, params.zoneId);

  const reg = await TournamentRegistration.findOne({
    tournamentId: params.tournamentId,
    playerId: params.playerId,
  });
  if (!reg) throw notFound("Player is not registered for this event");
  if (String(reg.zoneId) !== params.zoneId) {
    throw forbidden("This player registered through another zone — they check in there");
  }
  if (reg.checkedIn) throw badRequest("Already checked in");

  reg.checkedIn = true;
  reg.set("checkedInZoneId", new mongoose.Types.ObjectId(params.zoneId));
  reg.checkedInAt = new Date();
  await reg.save();
  return reg;
}

/**
 * The shared bracket. Deliberately narrow: a co-host sees who is playing, from
 * which zone, and how they placed — never another zone's contact details,
 * wallet, or anything else about the player (plan M6, §8).
 */
export async function sharedBracket(params: { tournamentId: string; zoneId?: string }) {
  const t = await Tournament.findById(params.tournamentId).lean();
  if (!t) throw notFound("Event not found");
  assertInvolved(asEventShape(t), params.zoneId);

  const regs = await TournamentRegistration.find({ tournamentId: params.tournamentId }).lean();
  const players = await Player.find(
    { _id: { $in: regs.map((r) => r.playerId) } },
    // Only public identity fields cross the zone boundary.
    { username: 1, gamerTag: 1, level: 1, rank: 1 }
  ).lean();
  const byId = new Map(players.map((p) => [String(p._id), p]));

  const zoneIds = involvedZoneIds(asEventShape(t));
  const zones = await Zone.find({ _id: { $in: zoneIds } }, { name: 1, city: 1 }).lean();
  const zoneName = new Map(zones.map((z) => [String(z._id), z.name as string]));

  const entrants = regs.map((r) => {
    const p = byId.get(String(r.playerId));
    return {
      playerId: String(r.playerId),
      displayName: (p?.gamerTag ?? p?.username ?? "Player") as string,
      level: p?.level ?? 1,
      rank: p?.rank ?? "Rookie",
      zoneId: String(r.zoneId),
      zoneName: zoneName.get(String(r.zoneId)) ?? "Unknown zone",
      checkedIn: Boolean(r.checkedIn),
      checkedInZoneId: r.checkedInZoneId ? String(r.checkedInZoneId) : null,
      placement: r.placement ?? null,
    };
  });

  // Per-zone counts are shared; per-zone money is not.
  const perZone = zoneIds.map((id) => ({
    zoneId: id,
    zoneName: zoneName.get(id) ?? "Unknown zone",
    isHost: id === String(t.zoneId),
    status:
      id === String(t.zoneId)
        ? "host"
        : asEventShape(t).participatingZones.find(
            (p) => String(p.zoneId) === id
          )?.status ?? "invited",
    registered: entrants.filter((e) => e.zoneId === id).length,
    checkedIn: entrants.filter((e) => e.zoneId === id && e.checkedIn).length,
  }));

  return {
    tournamentId: String(t._id),
    name: t.name,
    game: t.game,
    status: t.status,
    crossZone: Boolean(t.crossZone),
    hostZoneId: String(t.zoneId),
    entryFee: parseFloat(String(t.entryFee)),
    maxPlayers: t.maxPlayers,
    verificationStatus: t.verificationStatus,
    openDisputes: ((t.disputes ?? []) as unknown as { resolvedAt?: Date }[]).filter(
      (d) => !d.resolvedAt
    ).length,
    zones: perZone,
    entrants,
  };
}

/**
 * A participating zone submits its view of the placements. Nothing is paid out
 * here: for a cross-zone event every accepted zone must submit and the
 * submissions must agree (plan J9).
 */
export async function submitZoneResults(params: {
  tournamentId: string;
  zoneId: string;
  placements: { playerId: string; place: number }[];
  actorId: string;
}) {
  const t = await Tournament.findById(params.tournamentId);
  if (!t) throw notFound("Event not found");
  if (!acceptedZoneIds(t).includes(params.zoneId)) {
    throw forbidden("Only a participating zone can submit results");
  }
  if (t.status === "completed") throw badRequest("Results are already final");

  const places = params.placements.map((p) => p.place);
  if (new Set(places).size !== places.length) throw badRequest("Two players share a placement");

  const regs = await TournamentRegistration.find({ tournamentId: params.tournamentId })
    .select("playerId")
    .lean();
  const registered = new Set(regs.map((r) => String(r.playerId)));
  const stranger = params.placements.find((p) => !registered.has(p.playerId));
  if (stranger) throw badRequest(`Player ${stranger.playerId} is not registered for this event`);

  const existing = t.resultSubmissions.find((s) => String(s.zoneId) === params.zoneId);
  if (existing) {
    existing.placements = params.placements as never;
    existing.submittedBy = params.actorId;
    existing.submittedAt = new Date();
  } else {
    t.resultSubmissions.push({
      zoneId: new mongoose.Types.ObjectId(params.zoneId),
      placements: params.placements,
      submittedBy: params.actorId,
      submittedAt: new Date(),
    } as unknown as never);
  }

  const consensus = evaluateConsensus(asEventShape(t));
  t.verificationStatus = consensus.agreed && consensus.complete ? "verified" : "pending";
  if (t.disputes.some((d) => !d.resolvedAt)) t.verificationStatus = "disputed";
  await t.save();

  for (const zid of acceptedZoneIds(t)) {
    emitToZone(zid, "crosszone:results_submitted", {
      tournamentId: String(t._id),
      zoneId: params.zoneId,
      verificationStatus: t.verificationStatus,
    });
  }

  return { tournament: t, consensus };
}

/** Do all accepted zones agree, and has every one of them submitted? */
export function evaluateConsensus(t: EventZoneShape): {
  complete: boolean;
  agreed: boolean;
  missingZones: string[];
  conflicts: string[];
} {
  const required = t.crossZone ? acceptedZoneIds(t) : [String(t.zoneId)];
  const submittedBy = t.resultSubmissions.map((s) => String(s.zoneId));
  const missingZones = required.filter((z) => !submittedBy.includes(z));

  const normalize = (placements: { playerId: string; place: number }[]) =>
    JSON.stringify(
      [...placements]
        .map((p) => ({ playerId: String(p.playerId), place: p.place }))
        .sort((a, b) => a.place - b.place || a.playerId.localeCompare(b.playerId))
    );

  const signatures = new Map<string, string[]>();
  for (const sub of t.resultSubmissions) {
    const sig = normalize(sub.placements);
    signatures.set(sig, [...(signatures.get(sig) ?? []), String(sub.zoneId)]);
  }

  const agreed = signatures.size <= 1;
  const conflicts = agreed ? [] : [...signatures.values()].flat();

  return { complete: missingZones.length === 0, agreed, missingZones, conflicts };
}

/** A participating zone disputes the submitted results; this blocks payout. */
export async function raiseDispute(params: {
  tournamentId: string;
  zoneId: string;
  reason: string;
  actorId: string;
}) {
  const t = await Tournament.findById(params.tournamentId);
  if (!t) throw notFound("Event not found");
  if (!acceptedZoneIds(t).includes(params.zoneId)) {
    throw forbidden("Only a participating zone can dispute");
  }
  if (t.status === "completed") throw badRequest("The event is already settled");

  t.disputes.push({
    zoneId: new mongoose.Types.ObjectId(params.zoneId),
    raisedBy: params.actorId,
    reason: params.reason,
    raisedAt: new Date(),
  } as unknown as never);
  t.verificationStatus = "disputed";
  await t.save();

  for (const zid of acceptedZoneIds(t)) {
    emitToZone(zid, "crosszone:dispute", {
      tournamentId: String(t._id),
      zoneId: params.zoneId,
      reason: params.reason,
    });
  }
  return t;
}

/** The host resolves a dispute. Payout stays blocked while any remain open. */
export async function resolveDispute(params: {
  tournamentId: string;
  disputeId: string;
  hostZoneId: string;
  resolution: string;
  actorId: string;
}) {
  const t = await Tournament.findById(params.tournamentId);
  if (!t) throw notFound("Event not found");
  if (String(t.zoneId) !== params.hostZoneId) throw forbidden("Only the host zone can resolve");

  const dispute = t.disputes.find((d) => String((d as { _id: unknown })._id) === params.disputeId);
  if (!dispute) throw notFound("Dispute not found");
  if (dispute.resolvedAt) throw badRequest("Dispute already resolved");

  dispute.resolvedBy = params.actorId;
  dispute.resolvedAt = new Date();
  dispute.resolution = params.resolution;

  const stillOpen = t.disputes.some((d) => !d.resolvedAt);
  const consensus = evaluateConsensus(asEventShape(t));
  t.verificationStatus = stillOpen
    ? "disputed"
    : consensus.complete && consensus.agreed
      ? "verified"
      : "pending";
  await t.save();
  return t;
}

/**
 * Settles the event: awards XP and coins, and computes the prize and revenue
 * split. Refuses unless the results are verified and no dispute is open — the
 * plan is explicit that a dispute blocks final payout (J9).
 *
 * Prize money is credited in the **winner's own zone**, so a payout never moves
 * money across a tenant boundary (J10).
 */
export async function settleEvent(params: {
  tournamentId: string;
  hostZoneId: string;
  actorId: string;
}) {
  const t = await Tournament.findById(params.tournamentId);
  if (!t) throw notFound("Event not found");
  if (String(t.zoneId) !== params.hostZoneId) throw forbidden("Only the host zone can settle");
  if (t.status === "completed") throw badRequest("Event already settled");

  if (t.disputes.some((d) => !d.resolvedAt)) {
    throw conflict("An open dispute blocks the payout — resolve it first");
  }
  const consensus = evaluateConsensus(asEventShape(t));
  if (!consensus.complete) {
    throw conflict(`Waiting on result submissions from ${consensus.missingZones.length} zone(s)`);
  }
  if (!consensus.agreed) {
    throw conflict("Participating zones submitted different results — resolve before payout");
  }

  const placements = asEventShape(t).resultSubmissions[0].placements;
  const placeOf = new Map(placements.map((p) => [String(p.playerId), p.place]));

  const regs = await TournamentRegistration.find({ tournamentId: params.tournamentId });
  const fee = parseFloat(t.entryFee.toString());
  const paidRegs = regs.filter((r) => r.paymentStatus === "paid");
  const pool = +(fee * paidRegs.length).toFixed(2);

  // Fees collected per zone stay that zone's revenue.
  const feesByZone = new Map<string, number>();
  for (const r of paidRegs) {
    const zid = String(r.zoneId);
    feesByZone.set(zid, +((feesByZone.get(zid) ?? 0) + fee).toFixed(2));
  }

  const split = (t.prizeSplit as unknown as { place: number; percent: number }[]) ?? [];
  const prizeByPlace = new Map(
    split.map((s) => [s.place, +((pool * s.percent) / 100).toFixed(2)])
  );

  const results: {
    playerId: string;
    zoneId: string;
    place?: number;
    xp: number;
    coins: number;
    prize: number;
  }[] = [];

  await withTransaction(async (txn) => {
    for (const reg of regs) {
      if (reg.rewarded) continue;
      const pid = String(reg.playerId);
      const zid = String(reg.zoneId);
      const place = placeOf.get(pid);

      const bonus = place === 1 ? 2 : place === 2 ? 1.5 : place === 3 ? 1.2 : 1;
      const xpAmount = Math.round(t.xpReward * bonus);
      await awardEventXp(pid, xpAmount, txn);

      let coins = 0;
      if (place === 1) {
        coins = t.winnerCoins;
        await grantCoins({
          playerId: pid,
          amount: coins,
          type: "EVENT",
          reason: `won ${t.name}`,
          sourceId: String(t._id),
          zoneId: zid,
        });
      }

      const prize = place ? (prizeByPlace.get(place) ?? 0) : 0;
      if (prize > 0) {
        // Credited in the player's own zone — prize money does not cross zones.
        await addWalletEntry(
          {
            playerId: pid,
            zoneId: zid,
            amount: prize,
            type: "ADJUST",
            method: "WALLET",
            reference: `event-prize:${t._id}`,
            createdBy: params.actorId,
          },
          txn
        );
      }

      reg.placement = place;
      reg.rewarded = true;
      await reg.save({ session: txn });
      results.push({ playerId: pid, zoneId: zid, place, xp: xpAmount, coins, prize });
    }

    const prizeTotal = +results.reduce((s, r) => s + r.prize, 0).toFixed(2);
    t.settlement = {
      pool,
      prizeTotal,
      // What is left after prizes, apportioned by the configured revenue split
      // (default: each zone keeps the fees it collected).
      netByZone: apportionNet({
        feesByZone,
        results,
        revenueSplit: (t.revenueSplit as unknown as { zoneId: unknown; percent: number }[]) ?? [],
        pool,
        prizeTotal,
      }),
      feesByZone: Object.fromEntries(feesByZone),
      settledAt: new Date(),
      settledBy: params.actorId,
    };
    t.status = "completed";
    t.verificationStatus = "verified";
    await t.save({ session: txn });
  });

  for (const zid of acceptedZoneIds(t)) {
    emitToZone(zid, "crosszone:settled", { tournamentId: String(t._id), name: t.name });
  }
  for (const r of results) {
    await notify({
      playerId: r.playerId,
      type: "REWARD",
      title: r.place ? `You placed #${r.place} in ${t.name}` : `Thanks for playing ${t.name}`,
      body: `+${r.xp} XP${r.coins ? ` · +${r.coins} coins` : ""}${r.prize ? ` · ₹${r.prize} prize` : ""}`,
      zoneId: r.zoneId,
    });
  }

  return { tournamentId: String(t._id), settlement: t.settlement, results };
}

/**
 * How the money left after prizes is apportioned. With no explicit revenue
 * split each zone simply keeps what it collected minus the prizes paid to its
 * own players — the arrangement that needs no agreement between owners.
 */
function apportionNet(params: {
  feesByZone: Map<string, number>;
  results: { zoneId: string; prize: number }[];
  revenueSplit: { zoneId: unknown; percent: number }[];
  pool: number;
  prizeTotal: number;
}): Record<string, number> {
  const net = +(params.pool - params.prizeTotal).toFixed(2);

  if (params.revenueSplit.length) {
    const out: Record<string, number> = {};
    for (const s of params.revenueSplit) {
      out[String(s.zoneId)] = +((net * s.percent) / 100).toFixed(2);
    }
    return out;
  }

  const out: Record<string, number> = {};
  for (const [zid, fees] of params.feesByZone) {
    const prizesPaidHere = params.results
      .filter((r) => r.zoneId === zid)
      .reduce((s, r) => s + r.prize, 0);
    out[zid] = +(fees - prizesPaidHere).toFixed(2);
  }
  return out;
}

/** Flat XP grant for an event placement, with the level/rank snapshot updated. */
async function awardEventXp(playerId: string, xp: number, txn?: mongoose.ClientSession) {
  const { levelForXp, rankForLevel } = await import("../xp/xp.service.js");
  const player = await Player.findById(playerId).session(txn ?? null);
  if (!player) return;
  player.xpTotal += xp;
  player.level = levelForXp(player.xpTotal);
  player.rank = rankForLevel(player.level);
  await player.save({ session: txn });
}

/**
 * The settlement as one zone may see it: the shared totals, plus that zone's
 * own share. Another zone's net is never disclosed (plan J10, M6).
 */
export async function settlementFor(params: { tournamentId: string; zoneId: string }) {
  const t = await Tournament.findById(params.tournamentId).lean();
  if (!t) throw notFound("Event not found");
  assertInvolved(asEventShape(t), params.zoneId);
  if (!t.settlement) return { settled: false as const };

  const s = t.settlement as {
    pool: number;
    prizeTotal: number;
    netByZone: Record<string, number>;
    feesByZone: Record<string, number>;
    settledAt: Date;
  };
  const isHost = String(t.zoneId) === params.zoneId;

  return {
    settled: true as const,
    pool: s.pool,
    prizeTotal: s.prizeTotal,
    settledAt: s.settledAt,
    yourZoneId: params.zoneId,
    yourFees: s.feesByZone[params.zoneId] ?? 0,
    yourNet: s.netByZone[params.zoneId] ?? 0,
    // The host organised the event and owns the pool's arithmetic, so it sees
    // the full breakdown; a co-host sees only its own line.
    netByZone: isHost ? s.netByZone : undefined,
  };
}
