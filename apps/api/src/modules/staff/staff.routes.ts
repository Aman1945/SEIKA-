import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, forbidden, notFound } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { StaffUser } from "../../models/StaffUser.js";
import { audit } from "../audit/audit.service.js";

export const staffRouter = Router();
staffRouter.use(requireAuth);

const CREATABLE = ["BRANCH_MANAGER", "CASHIER", "TECHNICIAN", "EVENT_MANAGER"] as const;

/** Owner creates a staff account (they log in via OTP with audience=staff). */
staffRouter.post(
  "/",
  requireRole("ZONE_OWNER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1),
        role: z.enum(CREATABLE),
        phone: z.string().optional(),
        email: z.string().email().optional(),
        customRoleName: z.string().optional(),
        permissions: z.array(z.string()).optional(),
        branchId: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    if (!body.data.phone && !body.data.email) throw badRequest("phone or email required");
    if (!req.tenantZoneId) throw badRequest("No zone in context");

    const staff = await StaffUser.create({ ...body.data, zoneId: req.tenantZoneId });
    await audit({
      actorId: req.auth!.sub,
      zoneId: req.tenantZoneId,
      action: "STAFF_CREATE",
      entityType: "staff",
      entityId: String(staff._id),
      newValue: { role: body.data.role, name: body.data.name },
    });
    res.status(201).json({ ok: true, staffId: String(staff._id), role: staff.role });
  })
);

/** List staff in the zone. */
staffRouter.get(
  "/",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER"),
  asyncHandler(async (req, res) => {
    const staff = await StaffUser.find({ zoneId: req.tenantZoneId }).select("-__v").lean();
    res.json({ ok: true, staff });
  })
);

/** Update role / status / permissions. Staff cannot self-elevate. */
staffRouter.patch(
  "/:id",
  requireRole("ZONE_OWNER"),
  asyncHandler(async (req, res) => {
    if (req.auth!.sub === req.params.id) throw forbidden("Cannot edit your own role");
    const body = z
      .object({
        role: z.enum(CREATABLE).optional(),
        status: z.enum(["active", "disabled"]).optional(),
        permissions: z.array(z.string()).optional(),
      })
      .parse(req.body);
    const staff = await StaffUser.findOneAndUpdate(
      { _id: req.params.id, zoneId: req.tenantZoneId },
      body,
      { new: true }
    );
    if (!staff) throw notFound("Staff not found");
    await audit({
      actorId: req.auth!.sub,
      zoneId: req.tenantZoneId,
      action: "STAFF_UPDATE",
      entityType: "staff",
      entityId: req.params.id,
      newValue: body,
    });
    res.json({ ok: true, staffId: String(staff._id), role: staff.role, status: staff.status });
  })
);
