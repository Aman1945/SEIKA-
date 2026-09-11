import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { AuditLog } from "../../models/AuditLog.js";

export const auditRouter = Router();
auditRouter.use(requireAuth, requireRole("ZONE_OWNER", "BRANCH_MANAGER"));

/** Owner audit trail — zone-scoped, filterable, paginated. */
auditRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        action: z.string().optional(),
        entityType: z.string().optional(),
        limit: z.coerce.number().min(1).max(200).default(50),
        skip: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const filter: Record<string, unknown> = { zoneId: req.tenantZoneId };
    if (q.action) filter.action = q.action;
    if (q.entityType) filter.entityType = q.entityType;

    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.limit).lean(),
      AuditLog.countDocuments(filter),
    ]);
    res.json({ ok: true, total, logs });
  })
);
