import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, notFound } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { Zone, Branch } from "../../models/Zone.js";

export const zoneRouter = Router();

zoneRouter.use(requireAuth);

/** Create a branch under the owner's zone. */
zoneRouter.post(
  "/branches",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ name: z.string().min(1), address: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    const branch = await Branch.create({ zoneId: req.tenantZoneId, ...body.data });
    res.status(201).json({ ok: true, branch });
  })
);

zoneRouter.get(
  "/branches",
  asyncHandler(async (req, res) => {
    const branches = await Branch.find({ zoneId: req.tenantZoneId });
    res.json({ ok: true, branches });
  })
);

zoneRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const zone = await Zone.findById(req.tenantZoneId);
    if (!zone) throw notFound("Zone not found");
    res.json({ ok: true, zone });
  })
);

/** Owner toggles zone settings (e.g. enable postpaid). */
zoneRouter.patch(
  "/settings",
  requireRole("ZONE_OWNER"),
  asyncHandler(async (req, res) => {
    const body = z.object({ postpaidEnabled: z.boolean().optional() }).parse(req.body);
    const zone = await Zone.findByIdAndUpdate(req.tenantZoneId, body, { new: true });
    if (!zone) throw notFound("Zone not found");
    res.json({ ok: true, postpaidEnabled: zone.postpaidEnabled });
  })
);
