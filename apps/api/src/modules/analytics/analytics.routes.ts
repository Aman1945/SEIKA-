import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import {
  eventAnalytics,
  occupancy,
  overview,
  playerAnalytics,
  shopAnalytics,
} from "./analytics.service.js";
import { EXPORT_FORMATS, EXPORT_TYPES, renderExport } from "./export.service.js";
import { audit } from "../audit/audit.service.js";

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth, requireRole("ZONE_OWNER", "BRANCH_MANAGER"));

/** Owner dashboard "today" overview. */
analyticsRouter.get(
  "/overview",
  asyncHandler(async (req, res) => {
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    res.json({ ok: true, overview: await overview(req.tenantZoneId) });
  })
);

/** Occupancy: peak hours, idle seat-hours, busiest and quietest PCs (L2). */
analyticsRouter.get(
  "/occupancy",
  asyncHandler(async (req, res) => {
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    const q = z.object({ days: z.coerce.number().min(1).max(365).default(30) }).parse(req.query);
    res.json({ ok: true, occupancy: await occupancy(req.tenantZoneId, q.days) });
  })
);

/** Players: top players, new vs returning, retention (L3). */
analyticsRouter.get(
  "/players",
  asyncHandler(async (req, res) => {
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    const q = z.object({ days: z.coerce.number().min(1).max(365).default(30) }).parse(req.query);
    res.json({ ok: true, players: await playerAnalytics(req.tenantZoneId, q.days) });
  })
);

/** Shop: revenue, best sellers, slow movers, low stock (L4). */
analyticsRouter.get(
  "/shop",
  asyncHandler(async (req, res) => {
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    const q = z.object({ days: z.coerce.number().min(1).max(365).default(30) }).parse(req.query);
    res.json({ ok: true, shop: await shopAnalytics(req.tenantZoneId, q.days) });
  })
);

/** Events: registrations, revenue, per-zone performance (L5). */
analyticsRouter.get(
  "/events",
  asyncHandler(async (req, res) => {
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    res.json({ ok: true, events: await eventAnalytics(req.tenantZoneId) });
  })
);

/**
 * Export (L6/L7). Six datasets, three formats, an optional date range — and
 * every download is audit-logged with what was taken and how much of it.
 */
analyticsRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    const q = z
      .object({
        type: z.enum(EXPORT_TYPES).default("sessions"),
        format: z.enum(EXPORT_FORMATS).default("csv"),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
      })
      .parse(req.query);

    if (q.since && q.until && q.since > q.until) {
      throw badRequest("`since` must be before `until`");
    }

    const out = await renderExport({ ...q, zoneId: req.tenantZoneId });

    await audit({
      actorId: req.auth!.sub,
      actorType: "staff",
      zoneId: req.tenantZoneId,
      action: "DATA_EXPORT",
      entityType: "export",
      entityId: q.type,
      newValue: {
        type: q.type,
        format: q.format,
        rows: out.rows,
        since: q.since ?? null,
        until: q.until ?? null,
      },
    });

    res.setHeader("Content-Type", out.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
    res.send(out.body);
  })
);
