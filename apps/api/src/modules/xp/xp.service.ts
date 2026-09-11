import mongoose from "mongoose";
import { Player } from "../../models/Player.js";
import { RANKS } from "../../models/enums.js";
import { grantCoins } from "../coin/coin.service.js";

/** XP per valid gameplay minute (blueprint: ~50 XP/hour). Configurable later. */
const XP_PER_MINUTE = 50 / 60;

/** Small coin reward for every single level-up. */
const COIN_PER_LEVEL = 20;

/** Coin reward when a NEW rank is unlocked (blueprint §7 table). */
const RANK_COIN_REWARD: Record<string, number> = {
  Rookie: 100,
  Bronze: 250,
  Silver: 500,
  Gold: 800,
  Platinum: 1200,
  Diamond: 1800,
  Elite: 2500,
  "SEIKA Legend": 5000,
};

/** Ranks whose minimum level falls in (prevLevel, newLevel]. */
function ranksUnlockedBetween(prevLevel: number, newLevel: number): string[] {
  return RANKS.filter((r) => r.min > prevLevel && r.min <= newLevel).map((r) => r.rank);
}

/**
 * Level thresholds (cumulative XP required to REACH a level).
 * Blueprint: L1=500, L2=1000, L3=2000, then progressive scaling.
 */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  if (level === 2) return 500;
  if (level === 3) return 1000;
  if (level === 4) return 2000;
  // progressive scaling after L4
  return 2000 + Math.round(1000 * Math.pow(level - 3, 1.6));
}

export function levelForXp(xpTotal: number): number {
  let level = 1;
  while (level < 100 && xpTotal >= xpForLevel(level + 1)) level++;
  return level;
}

export function rankForLevel(level: number): string {
  return RANKS.find((r) => level >= r.min && level <= r.max)?.rank ?? "Rookie";
}

export function xpFromMinutes(validMinutes: number, gameMultiplier = 1): number {
  return Math.round(validMinutes * XP_PER_MINUTE * gameMultiplier);
}

/**
 * Awards XP for a completed session and updates the player's level/rank snapshot.
 * Returns level-up info (used later for coin rewards + UI reveal in P4).
 */
export async function awardSessionXp(
  playerId: string,
  validMinutes: number,
  opts: { sessionId?: string; zoneId?: string } = {}
) {
  const gained = xpFromMinutes(validMinutes);
  const player = await Player.findById(playerId);
  if (!player) return { gained: 0, leveledUp: false, coinsAwarded: 0, ranksUnlocked: [] as string[] };

  const prevLevel = player.level;
  player.xpTotal += gained;
  player.level = levelForXp(player.xpTotal);
  player.rank = rankForLevel(player.level);
  await player.save();

  const leveledUp = player.level > prevLevel;
  const ranksUnlocked = leveledUp ? ranksUnlockedBetween(prevLevel, player.level) : [];

  // Coin rewards on level-up (not money — separate ledger). sourceId ties them to
  // the session so a refund can reverse them.
  let coinsAwarded = 0;
  if (leveledUp) {
    coinsAwarded += COIN_PER_LEVEL * (player.level - prevLevel);
    for (const rank of ranksUnlocked) coinsAwarded += RANK_COIN_REWARD[rank] ?? 0;
    if (coinsAwarded > 0) {
      await grantCoins({
        playerId,
        amount: coinsAwarded,
        type: "LEVELUP",
        reason: `level ${prevLevel}→${player.level}${ranksUnlocked.length ? " · rank: " + ranksUnlocked.join(",") : ""}`,
        sourceId: opts.sessionId,
        zoneId: opts.zoneId,
      });
    }
  }

  return {
    gained,
    xpTotal: player.xpTotal,
    level: player.level,
    rank: player.rank,
    leveledUp,
    prevLevel,
    ranksUnlocked,
    coinsAwarded,
  };
}

/** Reverses previously-awarded XP (e.g. on refund). Recomputes level/rank. */
export async function reverseXp(
  playerId: string,
  xpAmount: number,
  session?: mongoose.ClientSession
) {
  if (xpAmount <= 0) return { reversed: 0 };
  const player = await Player.findById(playerId).session(session ?? null);
  if (!player) return { reversed: 0 };
  player.xpTotal = Math.max(0, player.xpTotal - xpAmount);
  player.level = levelForXp(player.xpTotal);
  player.rank = rankForLevel(player.level);
  await player.save({ session: session ?? undefined });
  return { reversed: xpAmount, xpTotal: player.xpTotal, level: player.level, rank: player.rank };
}
