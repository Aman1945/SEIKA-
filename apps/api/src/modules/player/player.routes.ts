import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, forbidden, notFound } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { Player } from "../../models/Player.js";
import { Session } from "../../models/Session.js";
import { Booking } from "../../models/Booking.js";
import { getWalletBalance } from "../wallet/wallet.service.js";
import { getCoinBalance } from "../coin/coin.service.js";
import { xpForLevel, rankForLevel } from "../xp/xp.service.js";
import { regionForCountry } from "../leaderboard/leaderboard.service.js";
import { audit } from "../audit/audit.service.js";

export const playerRouter = Router();
playerRouter.use(requireAuth);

async function buildPassport(playerId: string) {
  const player = await Player.findById(playerId).lean();
  if (!player) throw notFound("Player not found");

  const [walletBalance, coinBalance, recentSessions, bookingCount] = await Promise.all([
    getWalletBalance(playerId),
    getCoinBalance(playerId),
    Session.find({ playerId, status: { $in: ["COMPLETED", "REFUNDED"] } })
      .sort({ endTime: -1 })
      .limit(5)
      .select("pcId validMinutes cost xpAwarded status endTime")
      .lean(),
    Booking.countDocuments({ playerId }),
  ]);

  const curBase = xpForLevel(player.level);
  const nextReq = player.level >= 100 ? player.xpTotal : xpForLevel(player.level + 1);
  const span = Math.max(1, nextReq - curBase);
  const progress = Math.min(1, (player.xpTotal - curBase) / span);

  return {
    playerId: String(player._id),
    username: player.username,
    name: player.name,
    avatar: player.avatar ?? null,
    gamerTag: player.gamerTag ?? null,
    city: player.city ?? null,
    country: player.country ?? null,
    region: player.region ?? null,
    favoriteGames: player.favoriteGames ?? [],
    level: player.level,
    rank: player.rank,
    nextRank: rankForLevel(Math.min(100, player.level + 1)),
    xp: {
      total: player.xpTotal,
      currentLevelFloor: curBase,
      nextLevelAt: nextReq,
      progress: +progress.toFixed(3),
    },
    wallet: { balance: walletBalance, currency: "INR" },
    coins: coinBalance,
    stats: { bookings: bookingCount },
    recentSessions: recentSessions.map((s) => ({
      ...s,
      cost: s.cost ? parseFloat(String(s.cost)) : 0,
    })),
  };
}

/** Player's own passport. */
playerRouter.get(
  "/me/passport",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw forbidden("Players only");
    res.json({ ok: true, passport: await buildPassport(req.auth!.sub) });
  })
);

/** Passport by id — self, or staff viewing a player. */
playerRouter.get(
  "/:id/passport",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ === "player" && req.auth!.sub !== req.params.id)
      throw forbidden("Can only view own passport");
    res.json({ ok: true, passport: await buildPassport(req.params.id) });
  })
);

/**
 * Profile customization (plan A6). Only ever touches the caller's own document
 * — progression fields (xp/level/rank) are derived from sessions and ledgers,
 * so they are deliberately not writable here.
 */
const profileSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    gamerTag: z.string().min(2).max(24).optional(),
    avatar: z.string().max(500).optional(),
    city: z.string().max(60).optional(),
    country: z.string().max(60).optional(),
    favoriteGames: z.array(z.string().min(1).max(60)).max(10).optional(),
  })
  .strict();

playerRouter.patch(
  "/me",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw forbidden("Players only");
    const body = profileSchema.safeParse(req.body ?? {});
    if (!body.success) throw badRequest("Invalid profile", body.error.flatten());

    const before = await Player.findById(req.auth!.sub).lean();
    if (!before) throw notFound("Player not found");

    const update: Record<string, unknown> = { ...body.data };
    // Keep region consistent with country so the region leaderboard groups the
    // player correctly without a second field for them to fill in.
    if (body.data.country !== undefined) {
      update.region = regionForCountry(body.data.country) ?? null;
    }

    const player = await Player.findByIdAndUpdate(req.auth!.sub, update, {
      new: true,
      runValidators: true,
    }).lean();

    await audit({
      actorId: req.auth!.sub,
      actorType: "player",
      action: "PLAYER_PROFILE_UPDATE",
      entityType: "player",
      entityId: req.auth!.sub,
      oldValue: {
        gamerTag: before.gamerTag ?? null,
        city: before.city ?? null,
        country: before.country ?? null,
      },
      newValue: body.data,
    });

    res.json({ ok: true, passport: await buildPassport(String(player!._id)) });
  })
);
