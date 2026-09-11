import mongoose from "mongoose";
import { Player } from "../../models/Player.js";
import { Session } from "../../models/Session.js";

export type Scope = "global" | "region" | "country" | "city" | "zone" | "game";
export type Period = "weekly" | "monthly" | "all-time";

/** Minimal country → region map (extend as SEIKA expands). */
const REGION: Record<string, string[]> = {
  "South Asia": ["India", "Pakistan", "Bangladesh", "Sri Lanka", "Nepal"],
  "Middle East": ["UAE", "Saudi Arabia", "Qatar", "Kuwait", "Bahrain", "Oman"],
  Europe: ["UK", "Germany", "France", "Spain", "Italy"],
  "Southeast Asia": ["Singapore", "Malaysia", "Indonesia", "Thailand", "Philippines"],
};
function countriesInRegion(region?: string): string[] {
  return region ? REGION[region] ?? [] : [];
}

/** Reverse lookup — used when a player sets their country on their profile. */
export function regionForCountry(country?: string): string | undefined {
  if (!country) return undefined;
  for (const [region, countries] of Object.entries(REGION)) {
    if (countries.includes(country)) return region;
  }
  return undefined;
}

function windowStart(period: Period): Date | null {
  if (period === "all-time") return null;
  const days = period === "weekly" ? 7 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export interface LeaderboardRow {
  position: number;
  playerId: string;
  username: string;
  level: number;
  rank: string;
  xp: number;
}

/**
 * Leaderboard. Global all-time uses the player's lifetime xpTotal snapshot.
 * Zone-scoped or period-bounded boards aggregate completed-session XP in the
 * window. (Redis sorted-sets will back this at scale in P6.)
 */
export async function getLeaderboard(params: {
  scope: Scope;
  zoneId?: string;
  region?: string;
  country?: string;
  city?: string;
  period: Period;
  limit?: number;
}): Promise<LeaderboardRow[]> {
  const limit = Math.min(params.limit ?? 20, 100);

  // Geography scopes rank players by their lifetime XP snapshot.
  // (Period-bounded geo boards are a future enhancement.)
  if (["global", "region", "country", "city"].includes(params.scope)) {
    const geo: Record<string, unknown> = {};
    if (params.scope === "country" && params.country) geo.country = params.country;
    if (params.scope === "city" && params.city) geo.city = params.city;
    if (params.scope === "region") geo.country = { $in: countriesInRegion(params.region) };
    const players = await Player.find(geo).sort({ xpTotal: -1 }).limit(limit).lean();
    return players.map((p, i) => ({
      position: i + 1,
      playerId: String(p._id),
      username: p.username,
      level: p.level,
      rank: p.rank,
      xp: p.xpTotal,
    }));
  }

  // Zone (and game, once sessions carry game) → session-XP aggregation with period.
  const match: Record<string, unknown> = { status: "COMPLETED" };
  if (params.scope === "zone") {
    if (!params.zoneId) return [];
    match.zoneId = new mongoose.Types.ObjectId(params.zoneId);
  }
  const start = windowStart(params.period);
  if (start) match.endTime = { $gte: start };

  const rows = await Session.aggregate([
    { $match: match },
    { $group: { _id: "$playerId", xp: { $sum: "$xpAwarded" } } },
    { $sort: { xp: -1 } },
    { $limit: limit },
    { $lookup: { from: "players", localField: "_id", foreignField: "_id", as: "p" } },
    { $unwind: "$p" },
  ]);

  return rows.map((r, i) => ({
    position: i + 1,
    playerId: String(r._id),
    username: r.p.username,
    level: r.p.level,
    rank: r.p.rank,
    xp: r.xp,
  }));
}
