import { Router } from "express";
import { asyncHandler } from "../../common/asyncHandler.js";
import { forbidden, notFound } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import { Player } from "../../models/Player.js";
import { Session } from "../../models/Session.js";
import { Booking } from "../../models/Booking.js";
import { getWalletBalance } from "../wallet/wallet.service.js";
import { getCoinBalance } from "../coin/coin.service.js";
import { xpForLevel, rankForLevel } from "../xp/xp.service.js";

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
