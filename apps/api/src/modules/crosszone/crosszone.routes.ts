import { Router } from "express";
import { z } from "zod";

import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, forbidden } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { audit } from "../audit/audit.service.js";
import {
  asEventShape,
  checkInAtZone,
  evaluateConsensus,
  inviteZone,
  listConnections,
  raiseDispute,
  registerForEvent,
  requestConnection,
  resolveDispute,
  respondToConnection,
  respondToInvite,
  settleEvent,
  settlementFor,
  sharedBracket,
  submitZoneResults,
} from "./crosszone.service.js";
import { Tournament } from "../../models/Tournament.js";

export const crossZoneRouter = Router();
crossZoneRouter.use(requireAuth);

/** Roles that may negotiate co-hosting and submit/verify results. */
const EVENT_ROLES = ["SUPER_ADMIN", "ZONE_OWNER", "BRANCH_MANAGER", "EVENT_MANAGER"] as const;
/** Connecting two businesses is an owner decision, not an operator one. */
const OWNER_ROLES = ["SUPER_ADMIN", "ZONE_OWNER"] as const;

function zoneOf(req: { tenantZoneId?: string }): string {
  if (!req.tenantZoneId) throw badRequest("No zone in context");
  return req.tenantZoneId;
}

// ─── Owner-to-owner connections ──────────────────────────────────────────────

crossZoneRouter.post(
  "/connections",
  requireRole(...OWNER_ROLES),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ toZoneId: z.string(), message: z.string().max(500).optional() })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());

    const conn = await requestConnection({
      fromZoneId: zoneOf(req),
      toZoneId: body.data.toZoneId,
      requestedBy: req.auth!.sub,
      message: body.data.message,
    });

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: zoneOf(req),
      action: "ZONE_CONNECTION_REQUEST",
      entityType: "zoneConnection",
      entityId: String(conn._id),
      newValue: { toZoneId: body.data.toZoneId },
    });

    res.status(201).json({ ok: true, connectionId: String(conn._id), status: conn.status });
  })
);

crossZoneRouter.post(
  "/connections/:id/respond",
  requireRole(...OWNER_ROLES),
  asyncHandler(async (req, res) => {
    const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
    const conn = await respondToConnection({
      connectionId: req.params.id,
      zoneId: zoneOf(req),
      accept,
      respondedBy: req.auth!.sub,
    });

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: zoneOf(req),
      action: accept ? "ZONE_CONNECTION_ACCEPT" : "ZONE_CONNECTION_REJECT",
      entityType: "zoneConnection",
      entityId: String(conn._id),
    });

    res.json({ ok: true, status: conn.status });
  })
);

crossZoneRouter.get(
  "/connections",
  requireRole(...EVENT_ROLES),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, connections: await listConnections(zoneOf(req)) });
  })
);

// ─── Co-hosting ──────────────────────────────────────────────────────────────

crossZoneRouter.post(
  "/events/:id/invite",
  requireRole(...EVENT_ROLES),
  asyncHandler(async (req, res) => {
    const { zoneId } = z.object({ zoneId: z.string() }).parse(req.body);
    const t = await inviteZone({
      tournamentId: req.params.id,
      hostZoneId: zoneOf(req),
      inviteeZoneId: zoneId,
      actorId: req.auth!.sub,
    });

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: zoneOf(req),
      action: "CROSSZONE_INVITE",
      entityType: "tournament",
      entityId: String(t._id),
      newValue: { inviteeZoneId: zoneId },
    });

    res.status(201).json({ ok: true, participatingZones: t.participatingZones });
  })
);

crossZoneRouter.post(
  "/events/:id/invite/respond",
  requireRole(...EVENT_ROLES),
  asyncHandler(async (req, res) => {
    const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
    const t = await respondToInvite({
      tournamentId: req.params.id,
      zoneId: zoneOf(req),
      accept,
      actorId: req.auth!.sub,
    });

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: zoneOf(req),
      action: accept ? "CROSSZONE_INVITE_ACCEPT" : "CROSSZONE_INVITE_DECLINE",
      entityType: "tournament",
      entityId: req.params.id,
    });

    res.json({ ok: true, participatingZones: t.participatingZones });
  })
);

// ─── Registration & check-in ─────────────────────────────────────────────────

/** Player registers through a zone, paying from their wallet in that zone. */
crossZoneRouter.post(
  "/events/:id/register",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw forbidden("Players only");
    const { zoneId } = z.object({ zoneId: z.string() }).parse(req.body);

    const reg = await registerForEvent({
      tournamentId: req.params.id,
      playerId: req.auth!.sub,
      zoneId,
    });

    await audit({
      actorId: req.auth!.sub,
      actorType: "player",
      zoneId,
      action: "EVENT_REGISTER",
      entityType: "tournament",
      entityId: req.params.id,
      newValue: { zoneId },
    });

    res.status(201).json({
      ok: true,
      registrationId: String(reg._id),
      zoneId: String(reg.zoneId),
      paymentStatus: reg.paymentStatus,
    });
  })
);

/** Staff check in a player who registered through this zone. */
crossZoneRouter.post(
  "/events/:id/checkin",
  requireRole("SUPER_ADMIN", "ZONE_OWNER", "BRANCH_MANAGER", "CASHIER", "EVENT_MANAGER"),
  asyncHandler(async (req, res) => {
    const { playerId } = z.object({ playerId: z.string() }).parse(req.body);
    const reg = await checkInAtZone({
      tournamentId: req.params.id,
      playerId,
      zoneId: zoneOf(req),
      actorId: req.auth!.sub,
    });

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: zoneOf(req),
      action: "EVENT_CHECKIN",
      entityType: "tournament",
      entityId: req.params.id,
      newValue: { playerId },
    });

    res.json({ ok: true, checkedIn: reg.checkedIn, zoneId: String(reg.checkedInZoneId) });
  })
);

// ─── Shared bracket & results ────────────────────────────────────────────────

/** The shared bracket — event data only, no private tenant data. */
crossZoneRouter.get(
  "/events/:id/bracket",
  asyncHandler(async (req, res) => {
    // A player sees the bracket of an event they are registered for; staff see
    // the bracket of an event their zone takes part in.
    if (req.auth!.typ === "player") {
      const { TournamentRegistration } = await import("../../models/Tournament.js");
      const reg = await TournamentRegistration.findOne({
        tournamentId: req.params.id,
        playerId: req.auth!.sub,
      }).select("zoneId");
      if (!reg) throw forbidden("Register for this event to see its bracket");
      res.json({ ok: true, bracket: await sharedBracket({ tournamentId: req.params.id, zoneId: String(reg.zoneId) }) });
      return;
    }
    res.json({
      ok: true,
      bracket: await sharedBracket({ tournamentId: req.params.id, zoneId: zoneOf(req) }),
    });
  })
);

crossZoneRouter.post(
  "/events/:id/results",
  requireRole(...EVENT_ROLES),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        placements: z
          .array(z.object({ playerId: z.string(), place: z.number().int().positive() }))
          .min(1),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());

    const { tournament, consensus } = await submitZoneResults({
      tournamentId: req.params.id,
      zoneId: zoneOf(req),
      placements: body.data.placements,
      actorId: req.auth!.sub,
    });

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: zoneOf(req),
      action: "EVENT_RESULTS_SUBMIT",
      entityType: "tournament",
      entityId: req.params.id,
      newValue: { placements: body.data.placements },
    });

    res.json({
      ok: true,
      verificationStatus: tournament.verificationStatus,
      consensus,
    });
  })
);

crossZoneRouter.get(
  "/events/:id/verification",
  requireRole(...EVENT_ROLES),
  asyncHandler(async (req, res) => {
    const t = await Tournament.findById(req.params.id).lean();
    if (!t) throw badRequest("Event not found");
    const zoneId = zoneOf(req);
    const involved = [
      String(t.zoneId),
      ...asEventShape(t).participatingZones.map((p) => String(p.zoneId)),
    ];
    if (!involved.includes(zoneId)) throw badRequest("Event not found");

    res.json({
      ok: true,
      verificationStatus: t.verificationStatus,
      consensus: evaluateConsensus(asEventShape(t)),
      submissions: (t.resultSubmissions as unknown as { zoneId: unknown; submittedAt: Date }[]).map((s) => ({
        zoneId: String(s.zoneId),
        submittedAt: s.submittedAt,
      })),
      disputes: (t.disputes as unknown as Record<string, unknown>[]).map((d) => ({
        id: String(d._id),
        zoneId: String(d.zoneId),
        reason: d.reason,
        raisedAt: d.raisedAt,
        resolvedAt: d.resolvedAt ?? null,
        resolution: d.resolution ?? null,
      })),
    });
  })
);

crossZoneRouter.post(
  "/events/:id/disputes",
  requireRole(...EVENT_ROLES),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(3).max(1000) }).parse(req.body);
    const t = await raiseDispute({
      tournamentId: req.params.id,
      zoneId: zoneOf(req),
      reason,
      actorId: req.auth!.sub,
    });

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: zoneOf(req),
      action: "EVENT_DISPUTE_RAISE",
      entityType: "tournament",
      entityId: req.params.id,
      reason,
    });

    res.status(201).json({ ok: true, verificationStatus: t.verificationStatus });
  })
);

crossZoneRouter.post(
  "/events/:id/disputes/:disputeId/resolve",
  requireRole(...EVENT_ROLES),
  asyncHandler(async (req, res) => {
    const { resolution } = z.object({ resolution: z.string().min(3).max(1000) }).parse(req.body);
    const t = await resolveDispute({
      tournamentId: req.params.id,
      disputeId: req.params.disputeId,
      hostZoneId: zoneOf(req),
      resolution,
      actorId: req.auth!.sub,
    });

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: zoneOf(req),
      action: "EVENT_DISPUTE_RESOLVE",
      entityType: "tournament",
      entityId: req.params.id,
      newValue: { disputeId: req.params.disputeId, resolution },
    });

    res.json({ ok: true, verificationStatus: t.verificationStatus });
  })
);

// ─── Settlement ──────────────────────────────────────────────────────────────

/** Host settles: XP, coins, prizes, and the revenue split. Owner-level. */
crossZoneRouter.post(
  "/events/:id/settle",
  requireRole(...OWNER_ROLES),
  asyncHandler(async (req, res) => {
    const result = await settleEvent({
      tournamentId: req.params.id,
      hostZoneId: zoneOf(req),
      actorId: req.auth!.sub,
    });

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: zoneOf(req),
      action: "EVENT_SETTLE",
      entityType: "tournament",
      entityId: req.params.id,
      newValue: result.settlement as Record<string, unknown>,
    });

    res.json({ ok: true, ...result });
  })
);

/** A zone's view of the settlement: shared totals plus its own share. */
crossZoneRouter.get(
  "/events/:id/settlement",
  requireRole(...EVENT_ROLES),
  asyncHandler(async (req, res) => {
    res.json({
      ok: true,
      settlement: await settlementFor({ tournamentId: req.params.id, zoneId: zoneOf(req) }),
    });
  })
);
