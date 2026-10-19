import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, notFound, forbidden } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { PC } from "../../models/PC.js";
import { Session } from "../../models/Session.js";
import { issuePairingCode } from "../../common/pairingCode.js";
import { issueTokens } from "../auth/auth.service.js";
import { signQrToken } from "../../common/qr.js";
import { emitToZone, emitToPc } from "../realtime/io.js";
import { audit } from "../audit/audit.service.js";

export const pcRouter = Router();

/** Create a PC (owner/manager). */
pcRouter.post(
  "/",
  requireAuth,
  requireRole("ZONE_OWNER", "BRANCH_MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        branchId: z.string(),
        pcNumber: z.string(),
        hourlyRate: z.number().positive(),
        category: z.string().optional(),
        specs: z.record(z.any()).optional(),
        games: z.array(z.string()).optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    const pc = await PC.create({
      ...body.data,
      zoneId: req.tenantZoneId,
      hourlyRate: mongoose.Types.Decimal128.fromString(body.data.hourlyRate.toFixed(2)),
      clientKey: new mongoose.Types.ObjectId().toString() + Math.random().toString(36).slice(2),
    });
    res.status(201).json({ ok: true, pc });
  })
);

/** PC MAP — all PCs in the zone with live status. */
pcRouter.get(
  "/map",
  requireAuth,
  asyncHandler(async (req, res) => {
    const pcs = await PC.find({ zoneId: req.tenantZoneId }).lean();
    const active = await Session.find({
      zoneId: req.tenantZoneId,
      status: { $in: ["PENDING_AUTH", "AUTHORIZED", "ACTIVE", "PAUSED", "LOW_BALANCE"] },
    })
      .select("pcId playerId status startTime")
      .lean();
    const byPc = new Map(active.map((s) => [String(s.pcId), s]));
    res.json({
      ok: true,
      pcs: pcs.map((pc) => ({
        ...pc,
        hourlyRate: pc.hourlyRate ? parseFloat(pc.hourlyRate.toString()) : 0,
        activeSession: byPc.get(String(pc._id)) ?? null,
      })),
    });
  })
);

/** Generate a rotating QR token for a PC (kiosk displays it). */
pcRouter.post(
  "/:id/qr",
  asyncHandler(async (req, res) => {
    const pc = await PC.findById(req.params.id);
    if (!pc) throw notFound("PC not found");
    const qr = signQrToken(String(pc._id));
    // Issued together so the screen can never show a code and a QR that point
    // at different moments, and so one refresh retires both.
    const pair = await issuePairingCode(String(pc._id), String(pc.zoneId));
    res.json({ ok: true, pcId: String(pc._id), ...qr, pairCode: pair.code });
  })
);

/**
 * Hands the seated player's own session to the PC they are sitting at.
 *
 * The player signed in on their phone; the launcher on the PC should not ask
 * them to do it again. So the machine asks for a token — proving it is that
 * PC with its clientKey — and the server issues one only for the player who
 * is actually seated there, and only while the session is live.
 *
 * Nothing here is taken from the request: not the player, not the session.
 * The PC says who it is, and the server decides the rest.
 */
pcRouter.post(
  "/:id/session-handoff",
  asyncHandler(async (req, res) => {
    const { clientKey } = z.object({ clientKey: z.string() }).parse(req.body);
    const pc = await PC.findById(req.params.id);
    if (!pc) throw notFound("PC not found");
    if (pc.clientKey !== clientKey) throw forbidden("Invalid clientKey");

    const session = await Session.findOne({
      pcId: pc._id,
      status: { $in: ["ACTIVE", "PAUSED", "LOW_BALANCE"] },
    }).sort({ createdAt: -1 });

    // No live session means no one is seated, so there is nobody to hand over.
    if (!session) throw forbidden("No live session on this PC");

    const tokens = await issueTokens({
      subjectId: String(session.playerId),
      subjectType: "player",
      zoneId: String(session.zoneId),
    });

    // The clock is answered here rather than from the unlock message, so it
    // is right however the PC came to be unlocked — a session start, a staff
    // command, or a kiosk that restarted mid-session and missed the event.
    const endsAt =
      session.sessionMode === "FIXED_DURATION" && session.selectedMinutes && session.startTime
        ? new Date(session.startTime.getTime() + session.selectedMinutes * 60_000)
        : null;

    res.json({
      ok: true,
      accessToken: tokens.accessToken,
      sessionId: String(session._id),
      startedAt: session.startTime ?? null,
      endsAt,
      sessionMode: session.sessionMode,
    });
  })
);

/** Kiosk heartbeat (authenticated by clientKey, not JWT). */
pcRouter.post(
  "/:id/heartbeat",
  asyncHandler(async (req, res) => {
    const { clientKey } = z.object({ clientKey: z.string() }).parse(req.body);
    const pc = await PC.findById(req.params.id);
    if (!pc) throw notFound("PC not found");
    if (pc.clientKey !== clientKey) throw forbidden("Invalid clientKey");
    pc.lastHeartbeatAt = new Date();
    if (pc.status === "OFFLINE") pc.status = "AVAILABLE";
    await pc.save();
    emitToZone(String(pc.zoneId), "pc:heartbeat", { pcId: String(pc._id), at: pc.lastHeartbeatAt });
    res.json({ ok: true });
  })
);

/**
 * A kiosk reports that its local staff escape was used.
 *
 * Authenticated by clientKey like the heartbeat, because this arrives from the
 * machine rather than a signed-in person. Uses are batched: the escape exists
 * for outages, so the report usually cannot be delivered at the moment it
 * happens and several may be owed at once.
 */
pcRouter.post(
  "/:id/staff-escape",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        clientKey: z.string(),
        uses: z.array(z.object({ at: z.string() })).min(1).max(50),
      })
      .parse(req.body);

    const pc = await PC.findById(req.params.id);
    if (!pc) throw notFound("PC not found");
    if (pc.clientKey !== body.clientKey) throw forbidden("Invalid clientKey");

    // One audit entry per use, carrying when it actually happened rather than
    // when it was reported — otherwise an outage makes them all look
    // simultaneous.
    for (const use of body.uses) {
      await audit({
        actorId: `kiosk:${req.params.id}`,
        actorType: "staff",
        zoneId: String(pc.zoneId),
        action: "PC_STAFF_ESCAPE_USED",
        entityType: "pc",
        entityId: String(pc._id),
        reason: "Local staff code used to unlock this PC",
        newValue: { occurredAt: use.at, pcNumber: pc.pcNumber },
      });
    }

    res.json({ ok: true, recorded: body.uses.length });
  })
);

/** Staff sends a trusted command to a PC kiosk. */
pcRouter.post(
  "/:id/command",
  requireAuth,
  requireRole("ZONE_OWNER", "BRANCH_MANAGER", "TECHNICIAN"),
  asyncHandler(async (req, res) => {
    const { action } = z
      .object({ action: z.enum(["lock", "unlock", "restart", "shutdown", "maintenance"]) })
      .parse(req.body);
    const pc = await PC.findById(req.params.id);
    if (!pc) throw notFound("PC not found");
    if (String(pc.zoneId) !== req.tenantZoneId) throw forbidden("Cross-tenant");
    emitToPc(String(pc._id), "command", { action });
    await audit({
      actorId: req.auth!.sub,
      zoneId: req.tenantZoneId,
      action: `PC_COMMAND_${action.toUpperCase()}`,
      entityType: "pc",
      entityId: String(pc._id),
    });
    res.json({ ok: true, sent: action });
  })
);
