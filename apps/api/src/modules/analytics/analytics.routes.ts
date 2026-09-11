import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { overview, sessionsCsv } from "./analytics.service.js";
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

/** CSV export (access is logged). */
analyticsRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    const q = z
      .object({ type: z.enum(["sessions"]).default("sessions"), since: z.coerce.date().optional() })
      .parse(req.query);
    const csv = await sessionsCsv(req.tenantZoneId, q.since);
    await audit({
      actorId: req.auth!.sub,
      zoneId: req.tenantZoneId,
      action: "DATA_EXPORT",
      entityType: "export",
      entityId: q.type,
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${q.type}.csv"`);
    res.send(csv);
  })
);
