import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, notFound } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { PricingRule } from "../../models/PricingRule.js";
import { PC } from "../../models/PC.js";
import { resolveRate } from "./pricing.service.js";
import { audit } from "../audit/audit.service.js";

export const pricingRouter = Router();
pricingRouter.use(requireAuth);

/** "21:30" → 1290. Minutes are what the resolver compares. */
const timeToMinutes = (t: string): number => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t.trim());
  if (!m) throw badRequest(`"${t}" is not a time — use HH:MM, 24-hour`);
  return Number(m[1]) * 60 + Number(m[2]);
};

const minutesToTime = (n: number): string =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

const ruleBody = z.object({
  label: z.string().min(1),
  start: z.string(),
  end: z.string(),
  days: z.array(z.number().int().min(0).max(6)).optional(),
  branchId: z.string().optional(),
  category: z.string().optional(),
  rate: z.number().nonnegative().optional(),
  multiplier: z.number().positive().optional(),
  active: z.boolean().optional(),
});

const shape = (r: Record<string, unknown>) => ({
  id: String(r._id),
  label: r.label,
  start: minutesToTime(r.startMinute as number),
  end: minutesToTime(r.endMinute as number),
  days: r.days ?? [],
  branchId: r.branchId ? String(r.branchId) : null,
  category: r.category ?? null,
  rate: r.rate != null ? parseFloat(String(r.rate)) : null,
  multiplier: r.multiplier ?? null,
  active: r.active,
});

/** Every rule in the zone, newest last so the list reads as it was built. */
pricingRouter.get(
  "/rules",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER", "CASHIER"),
  asyncHandler(async (req, res) => {
    const rules = await PricingRule.find({ zoneId: req.tenantZoneId }).sort({ createdAt: 1 }).lean();
    res.json({ ok: true, rules: rules.map((r) => shape(r as Record<string, unknown>)) });
  })
);

pricingRouter.post(
  "/rules",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER"),
  asyncHandler(async (req, res) => {
    const body = ruleBody.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    if (!req.tenantZoneId) throw badRequest("No zone in context");

    const { rate, multiplier } = body.data;
    // One or the other. Both would leave the zone guessing which applied, and
    // neither leaves a rule that does nothing.
    if (rate == null && multiplier == null) {
      throw badRequest("Give either a rate or a multiplier");
    }
    if (rate != null && multiplier != null) {
      throw badRequest("Give a rate or a multiplier, not both");
    }

    const rule = await PricingRule.create({
      zoneId: req.tenantZoneId,
      branchId: body.data.branchId ? new mongoose.Types.ObjectId(body.data.branchId) : null,
      category: body.data.category ?? null,
      label: body.data.label,
      days: body.data.days ?? [],
      startMinute: timeToMinutes(body.data.start),
      endMinute: timeToMinutes(body.data.end),
      rate: rate != null ? mongoose.Types.Decimal128.fromString(rate.toFixed(2)) : null,
      multiplier: multiplier ?? null,
      active: body.data.active ?? true,
    });

    await audit({
      actorId: req.auth!.sub,
      zoneId: String(req.tenantZoneId),
      action: "PRICING_RULE_CREATE",
      entityType: "pricingRule",
      entityId: String(rule._id),
      newValue: { label: rule.label, rate, multiplier },
    });

    res.status(201).json({ ok: true, rule: shape(rule.toObject() as Record<string, unknown>) });
  })
);

pricingRouter.patch(
  "/rules/:id",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER"),
  asyncHandler(async (req, res) => {
    const body = ruleBody.partial().safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());

    const patch: Record<string, unknown> = {};
    if (body.data.label != null) patch.label = body.data.label;
    if (body.data.start != null) patch.startMinute = timeToMinutes(body.data.start);
    if (body.data.end != null) patch.endMinute = timeToMinutes(body.data.end);
    if (body.data.days != null) patch.days = body.data.days;
    if (body.data.category !== undefined) patch.category = body.data.category ?? null;
    if (body.data.active != null) patch.active = body.data.active;
    if (body.data.rate != null) {
      patch.rate = mongoose.Types.Decimal128.fromString(body.data.rate.toFixed(2));
      patch.multiplier = null;
    }
    if (body.data.multiplier != null) {
      patch.multiplier = body.data.multiplier;
      patch.rate = null;
    }

    const rule = await PricingRule.findOneAndUpdate(
      { _id: req.params.id, zoneId: req.tenantZoneId },
      patch,
      { new: true }
    );
    if (!rule) throw notFound("Rule not found");

    await audit({
      actorId: req.auth!.sub,
      zoneId: String(req.tenantZoneId),
      action: "PRICING_RULE_UPDATE",
      entityType: "pricingRule",
      entityId: String(rule._id),
      newValue: patch,
    });

    res.json({ ok: true, rule: shape(rule.toObject() as Record<string, unknown>) });
  })
);

pricingRouter.delete(
  "/rules/:id",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER"),
  asyncHandler(async (req, res) => {
    const rule = await PricingRule.findOneAndDelete({
      _id: req.params.id,
      zoneId: req.tenantZoneId,
    });
    if (!rule) throw notFound("Rule not found");
    await audit({
      actorId: req.auth!.sub,
      zoneId: String(req.tenantZoneId),
      action: "PRICING_RULE_DELETE",
      entityType: "pricingRule",
      entityId: String(rule._id),
      oldValue: { label: rule.label },
    });
    res.json({ ok: true });
  })
);

/**
 * What a PC costs at a moment, and which rule decided it.
 *
 * Staff write a rule and want to see it land before a player does. Without
 * this the only way to check is to start a session and read the charge.
 */
pricingRouter.get(
  "/quote/:pcId",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER", "CASHIER"),
  asyncHandler(async (req, res) => {
    const pc = await PC.findOne({ _id: req.params.pcId, zoneId: req.tenantZoneId }).lean();
    if (!pc) throw notFound("PC not found");

    const at = req.query.at ? new Date(String(req.query.at)) : new Date();
    if (Number.isNaN(at.getTime())) throw badRequest("`at` is not a date");

    const priced = await resolveRate(pc as never, at);
    res.json({ ok: true, at: at.toISOString(), ...priced });
  })
);
