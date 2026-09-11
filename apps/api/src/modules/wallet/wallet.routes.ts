import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, forbidden } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { getWalletBalance, addWalletEntry } from "./wallet.service.js";
import { WalletLedger } from "../../models/WalletLedger.js";
import { audit } from "../audit/audit.service.js";

export const walletRouter = Router();
walletRouter.use(requireAuth);

/** Player sees own balance; staff can query any player in their zone. */
walletRouter.get(
  "/:playerId/balance",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ === "player" && req.auth!.sub !== req.params.playerId)
      throw forbidden("Can only view own balance");
    const zoneId = req.auth!.typ === "staff" ? req.tenantZoneId : undefined;
    const balance = await getWalletBalance(req.params.playerId, zoneId);
    res.json({ ok: true, playerId: req.params.playerId, balance });
  })
);

walletRouter.get(
  "/:playerId/ledger",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ === "player" && req.auth!.sub !== req.params.playerId)
      throw forbidden("Can only view own ledger");
    const rows = await WalletLedger.find({ playerId: req.params.playerId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({
      ok: true,
      ledger: rows.map((r) => ({ ...r, amount: parseFloat(r.amount.toString()) })),
    });
  })
);

/** Cash top-up by cashier (creates a ledger credit). Full Razorpay flow lands in P3. */
walletRouter.post(
  "/topup",
  requireRole("ZONE_OWNER", "BRANCH_MANAGER", "CASHIER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ playerId: z.string(), amount: z.number().positive(), method: z.enum(["CASH", "GATEWAY"]).default("CASH") })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    if (!req.tenantZoneId) throw badRequest("No zone in context");
    const entry = await addWalletEntry({
      playerId: body.data.playerId,
      zoneId: req.tenantZoneId,
      amount: body.data.amount,
      type: "TOPUP",
      method: body.data.method,
      createdBy: req.auth!.sub,
    });
    await audit({
      actorId: req.auth!.sub,
      zoneId: req.tenantZoneId,
      action: "WALLET_TOPUP",
      entityType: "wallet",
      entityId: body.data.playerId,
      newValue: { amount: body.data.amount, method: body.data.method },
    });
    const balance = await getWalletBalance(body.data.playerId, req.tenantZoneId);
    res.status(201).json({ ok: true, entryId: String(entry._id), balance });
  })
);
