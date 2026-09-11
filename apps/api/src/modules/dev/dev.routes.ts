import { Router } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../../common/asyncHandler.js";
import { env } from "../../config/env.js";
import { Zone, Branch } from "../../models/Zone.js";
import { PC } from "../../models/PC.js";
import { StaffUser } from "../../models/StaffUser.js";
import { issueTokens } from "../auth/auth.service.js";

/**
 * DEV-ONLY seeding. Creates a zone + owner + branch + PC and returns an owner
 * token + the PC clientKey — so the full loop can be tested without a UI.
 * Disabled in production.
 */
export const devRouter = Router();

devRouter.post(
  "/seed",
  asyncHandler(async (req, res) => {
    if (env.isProd) return res.status(404).json({ error: { code: "NOT_FOUND" } });

    const owner = await StaffUser.create({
      role: "ZONE_OWNER",
      name: "Demo Owner",
      email: `owner_${Date.now()}@seika.dev`,
    });
    const zone = await Zone.create({
      ownerId: owner._id,
      name: "SEIKA Demo Zone",
      country: "India",
      city: "Mumbai",
      verified: true,
    });
    owner.set("zoneId", zone._id);
    await owner.save();

    const branch = await Branch.create({ zoneId: zone._id, name: "Main Branch" });
    const pc = await PC.create({
      zoneId: zone._id,
      branchId: branch._id,
      pcNumber: "PC-01",
      hourlyRate: mongoose.Types.Decimal128.fromString("60.00"),
      category: "standard",
      clientKey: `demo-key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });

    // Auto-create one staff of each role so all roles can be tested immediately.
    const staffDefs = [
      { name: "Ravi (Cashier)", role: "CASHIER", phone: "9700000001" },
      { name: "Neha (Manager)", role: "BRANCH_MANAGER", phone: "9700000002" },
      { name: "Sam (Technician)", role: "TECHNICIAN", phone: "9700000003" },
      { name: "Anil (Events)", role: "EVENT_MANAGER", phone: "9700000004" },
    ];
    const staff = [];
    for (const d of staffDefs) {
      await StaffUser.deleteOne({ phone: d.phone }); // idempotent across re-seeds
      const su = await StaffUser.create({ ...d, zoneId: zone._id });
      staff.push({ name: d.name, role: d.role, phone: d.phone, id: String(su._id) });
    }

    const ownerTokens = await issueTokens({
      subjectId: String(owner._id),
      subjectType: "staff",
      role: "ZONE_OWNER",
      zoneId: String(zone._id),
    });

    res.status(201).json({
      ok: true,
      zoneId: String(zone._id),
      branchId: String(branch._id),
      pc: { id: String(pc._id), clientKey: pc.clientKey, hourlyRate: 60 },
      ownerAccessToken: ownerTokens.accessToken,
      staff,
    });
  })
);
