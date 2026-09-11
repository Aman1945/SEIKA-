import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, forbidden } from "../../common/errors.js";
import { requireAuth, optionalAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";
import { Tournament, TournamentRegistration } from "../../models/Tournament.js";
import { register, submitResults } from "./tournament.service.js";

export const tournamentRouter = Router();

/** Organizer creates a tournament. */
tournamentRouter.post(
  "/",
  requireAuth,
  requireRole("ZONE_OWNER", "BRANCH_MANAGER", "EVENT_MANAGER"),
  asyncHandler(async (req, res) => {
    const b = z
      .object({
        name: z.string().min(1),
        game: z.string().optional(),
        entryFee: z.number().nonnegative().default(0),
        prize: z.string().optional(),
        maxPlayers: z.number().int().positive().default(16),
        xpReward: z.number().int().nonnegative().optional(),
        winnerCoins: z.number().int().nonnegative().optional(),
      })
      .safeParse(req.body);
    if (!b.success) throw badRequest("Invalid body", b.error.flatten());
    if (!req.tenantZoneId) throw badRequest("No zone");
    const { entryFee, ...rest } = b.data;
    const t = await Tournament.create({
      ...rest,
      zoneId: req.tenantZoneId,
      entryFee: mongoose.Types.Decimal128.fromString(entryFee.toFixed(2)),
    });
    res.status(201).json({ ok: true, tournamentId: String(t._id) });
  })
);

/** List tournaments for a zone. */
tournamentRouter.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const zoneId = req.auth?.typ === "staff" ? req.tenantZoneId : (req.query.zoneId as string);
    if (!zoneId) throw badRequest("zoneId required");
    const list = await Tournament.find({ zoneId }).sort({ createdAt: -1 }).limit(30).lean();
    res.json({
      ok: true,
      tournaments: list.map((t) => ({ ...t, entryFee: parseFloat(String(t.entryFee)) })),
    });
  })
);

/** Player registers (pays entry fee from wallet). */
tournamentRouter.post(
  "/:id/register",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw forbidden("Players only");
    const reg = await register(req.params.id, req.auth!.sub);
    res.status(201).json({ ok: true, registrationId: String(reg._id), paymentStatus: reg.paymentStatus });
  })
);

/** Check in at the venue. */
tournamentRouter.post(
  "/:id/checkin",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw forbidden("Players only");
    const reg = await TournamentRegistration.findOneAndUpdate(
      { tournamentId: req.params.id, playerId: req.auth!.sub },
      { checkedIn: true },
      { new: true }
    );
    if (!reg) throw badRequest("Not registered");
    res.json({ ok: true, checkedIn: true });
  })
);

/** Organizer submits final placements → awards XP + coins. */
tournamentRouter.post(
  "/:id/results",
  requireAuth,
  requireRole("ZONE_OWNER", "BRANCH_MANAGER", "EVENT_MANAGER"),
  asyncHandler(async (req, res) => {
    const b = z
      .object({ placements: z.array(z.object({ playerId: z.string(), place: z.number().int().positive() })) })
      .parse(req.body);
    const result = await submitResults(req.params.id, b.placements);
    res.json({ ok: true, ...result });
  })
);
