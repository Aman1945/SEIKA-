import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { optionalAuth } from "../../middleware/auth.js";
import { getLeaderboard } from "./leaderboard.service.js";

export const leaderboardRouter = Router();

/**
 * @openapi
 * /leaderboard:
 *   get: { tags: [Leaderboard], summary: "Ranked players by scope + period" }
 */
leaderboardRouter.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        scope: z.enum(["global", "region", "country", "city", "zone", "game"]).default("global"),
        period: z.enum(["weekly", "monthly", "all-time"]).default("all-time"),
        zoneId: z.string().optional(),
        region: z.string().optional(),
        country: z.string().optional(),
        city: z.string().optional(),
        limit: z.coerce.number().min(1).max(100).default(20),
      })
      .parse(req.query);
    const rows = await getLeaderboard(q);
    res.json({ ok: true, scope: q.scope, period: q.period, leaderboard: rows });
  })
);
