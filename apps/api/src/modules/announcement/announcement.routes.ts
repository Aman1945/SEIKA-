import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest } from "../../common/errors.js";
import { requireAuth, optionalAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { Announcement } from "../../models/Announcement.js";
import { emitToZone } from "../realtime/io.js";
import { audit } from "../audit/audit.service.js";

export const announcementRouter = Router();

/** Owner/manager publishes an announcement (broadcast live to the zone). */
announcementRouter.post(
  "/",
  requireAuth,
  requireRole("ZONE_OWNER", "BRANCH_MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ title: z.string().min(1), body: z.string().optional(), pinned: z.boolean().optional() })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    const a = await Announcement.create({ ...body.data, zoneId: req.tenantZoneId, createdBy: req.auth!.sub });
    emitToZone(req.tenantZoneId, "announcement", { title: a.title, body: a.body });
    await audit({
      actorId: req.auth!.sub,
      zoneId: req.tenantZoneId,
      action: "ANNOUNCEMENT_PUBLISH",
      entityType: "announcement",
      entityId: String(a._id),
    });
    res.status(201).json({ ok: true, announcementId: String(a._id) });
  })
);

/** List active announcements for a zone (players/public). */
announcementRouter.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const zoneId = req.auth?.typ === "staff" ? req.tenantZoneId : (req.query.zoneId as string);
    if (!zoneId) throw badRequest("zoneId required");
    const list = await Announcement.find({ zoneId, active: true })
      .sort({ pinned: -1, createdAt: -1 })
      .limit(20)
      .lean();
    res.json({ ok: true, announcements: list });
  })
);

/** Deactivate an announcement. */
announcementRouter.patch(
  "/:id/archive",
  requireAuth,
  requireRole("ZONE_OWNER", "BRANCH_MANAGER"),
  asyncHandler(async (req, res) => {
    await Announcement.updateOne({ _id: req.params.id, zoneId: req.tenantZoneId }, { active: false });
    res.json({ ok: true });
  })
);
