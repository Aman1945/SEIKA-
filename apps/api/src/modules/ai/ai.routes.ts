import { Router } from "express";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { generateInsights } from "./ai.service.js";

export const aiRouter = Router();
aiRouter.use(requireAuth, requireRole("ZONE_OWNER", "BRANCH_MANAGER"));

/** AI business insights for the owner dashboard. */
aiRouter.get(
  "/insights",
  asyncHandler(async (req, res) => {
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    res.json({ ok: true, ...(await generateInsights(req.tenantZoneId)) });
  })
);
