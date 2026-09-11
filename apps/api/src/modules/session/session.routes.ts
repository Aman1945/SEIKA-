import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, forbidden } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { verifyQrToken } from "../../common/qr.js";
import { attachPlayer, authorizeSession } from "./session.engine.js";
import { startSession, endSession, refundSession } from "./session.service.js";
import { requireRole } from "../../middleware/rbac.js";
import { emitToZone } from "../realtime/io.js";
import { Session } from "../../models/Session.js";
import { audit } from "../audit/audit.service.js";
import type { PaymentSource } from "../../models/enums.js";

export const sessionRouter = Router();
sessionRouter.use(requireAuth);

/** Player scans PC QR → attach (PENDING_AUTH). QR login = 0 XP, PC stays LOCKED. */
sessionRouter.post(
  "/attach",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw forbidden("Players only");
    const { qrToken } = z.object({ qrToken: z.string() }).parse(req.body);
    let pcId: string;
    try {
      pcId = verifyQrToken(qrToken).pcId;
    } catch {
      throw badRequest("Invalid or expired QR token");
    }
    const session = await attachPlayer(pcId, req.auth!.sub);
    emitToZone(String(session.zoneId), "qr:scanned", {
      pcId,
      sessionId: String(session._id),
      playerId: req.auth!.sub,
    });
    res.status(201).json({
      ok: true,
      sessionId: String(session._id),
      status: session.status,
      note: "PC locked — awaiting payment authorization",
    });
  })
);

/** Run the Session Authorization Engine. Cash source requires staff role. */
sessionRouter.post(
  "/:id/authorize",
  asyncHandler(async (req, res) => {
    const { source, voucherCode, sessionMode, selectedMinutes } = z
      .object({
        source: z.enum(["WALLET", "BOOKING", "CASH", "PACKAGE", "VOUCHER", "POSTPAID"]),
        voucherCode: z.string().optional(),
        sessionMode: z.enum(["FIXED_DURATION", "OPEN_HOUR"]).optional(),
        selectedMinutes: z.number().int().optional(),
      })
      .parse(req.body);
    const staffApproved = req.auth!.typ === "staff";
    const result = await authorizeSession(req.params.id, source as PaymentSource, {
      staffApproved,
      voucherCode,
      sessionMode,
      selectedMinutes,
    });
    if (!result.authorized) {
      res.status(402).json({ ok: false, ...result });
      return;
    }
    res.json({ ok: true, ...result });
  })
);

/** Start (unlock) — staff-triggered, or player after wallet authorization. */
sessionRouter.post(
  "/:id/start",
  asyncHandler(async (req, res) => {
    const session = await startSession(req.params.id);
    res.json({ ok: true, sessionId: String(session._id), status: session.status, startTime: session.startTime });
  })
);

/** End session → compute valid minutes, deduct cost, award XP. */
sessionRouter.post(
  "/:id/end",
  asyncHandler(async (req, res) => {
    const result = await endSession(req.params.id);
    await audit({
      actorId: req.auth!.sub,
      actorType: req.auth!.typ,
      action: "SESSION_END",
      entityType: "session",
      entityId: req.params.id,
      newValue: { validMinutes: result.validMinutes, cost: result.cost },
    });
    res.json({ ok: true, ...result });
  })
);

/** Refund a completed session (staff only) → reverses wallet + XP + coins. */
sessionRouter.post(
  "/:id/refund",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER", "CASHIER"),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    const result = await refundSession(req.params.id, req.auth!.sub, reason);
    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: req.tenantZoneId,
      action: "SESSION_REFUND",
      entityType: "session",
      entityId: req.params.id,
      reason,
      newValue: result,
    });
    res.json({ ok: true, ...result });
  })
);

/** Session history — player sees own; staff sees the zone's. Paginated. */
sessionRouter.get(
  "/history/list",
  asyncHandler(async (req, res) => {
    const q = z
      .object({ limit: z.coerce.number().min(1).max(100).default(20), skip: z.coerce.number().min(0).default(0) })
      .parse(req.query);
    const filter: Record<string, unknown> =
      req.auth!.typ === "player" ? { playerId: req.auth!.sub } : { zoneId: req.tenantZoneId };
    const [rows, total] = await Promise.all([
      Session.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.limit).lean(),
      Session.countDocuments(filter),
    ]);
    res.json({
      ok: true,
      total,
      sessions: rows.map((s) => ({ ...s, cost: s.cost ? parseFloat(String(s.cost)) : 0 })),
    });
  })
);

sessionRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const session = await Session.findById(req.params.id).lean();
    if (!session) throw badRequest("Not found");
    res.json({ ok: true, session });
  })
);
