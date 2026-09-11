import mongoose from "mongoose";
import { Tournament, TournamentRegistration } from "../../models/Tournament.js";
import { badRequest, conflict, notFound } from "../../common/errors.js";
import { withTransaction } from "../../config/db.js";
import { addWalletEntry, getWalletBalance } from "../wallet/wallet.service.js";
import { awardSessionXp } from "../xp/xp.service.js";
import { grantCoins } from "../coin/coin.service.js";
import { notify } from "../notification/notification.service.js";
import { emitToZone } from "../realtime/io.js";

/** Player registers for a tournament; pays entry fee from wallet (money-safe). */
export async function register(tournamentId: string, playerId: string) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw notFound("Tournament not found");
  if (!["registration", "upcoming"].includes(t.status)) throw badRequest(`Registration closed (${t.status})`);

  const count = await TournamentRegistration.countDocuments({ tournamentId });
  if (count >= t.maxPlayers) throw conflict("Tournament full");

  const fee = parseFloat(t.entryFee.toString());
  const paymentStatus = fee > 0 ? "paid" : "free";

  return withTransaction(async (txn) => {
    if (fee > 0) {
      const bal = await getWalletBalance(playerId, String(t.zoneId));
      if (bal < fee) throw badRequest(`Insufficient balance (need ₹${fee})`);
      await addWalletEntry(
        { playerId, zoneId: String(t.zoneId), amount: -fee, type: "BOOKING", method: "WALLET", reference: `tournament:${tournamentId}`, createdBy: playerId },
        txn
      );
    }
    try {
      const [reg] = await TournamentRegistration.create([{ tournamentId, playerId, paymentStatus }], { session: txn });
      return reg;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw conflict("Already registered");
      throw e;
    }
  });
}

/**
 * Organizer submits final placements. Awards participation XP to all checked-in
 * (or all) players, winner coins to 1st, and notifies. Marks tournament completed.
 */
export async function submitResults(
  tournamentId: string,
  placements: { playerId: string; place: number }[]
) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw notFound("Tournament not found");
  if (t.status === "completed") throw badRequest("Results already submitted");

  const regs = await TournamentRegistration.find({ tournamentId });
  const placeMap = new Map(placements.map((p) => [p.playerId, p.place]));
  const results: { playerId: string; place?: number; xp: number; coins: number }[] = [];

  for (const reg of regs) {
    if (reg.rewarded) continue;
    const pid = String(reg.playerId);
    const place = placeMap.get(pid);
    // participation XP for everyone; bonus for podium
    const bonus = place === 1 ? 2 : place === 2 ? 1.5 : place === 3 ? 1.2 : 1;
    const xpAmount = Math.round(t.xpReward * bonus);
    // award XP by faking "minutes" is wrong — grant directly via a helper:
    const p = await awardTournamentXp(pid, xpAmount);
    let coins = 0;
    if (place === 1) {
      coins = t.winnerCoins;
      await grantCoins({ playerId: pid, amount: coins, type: "EVENT", reason: `won ${t.name}`, sourceId: tournamentId, zoneId: String(t.zoneId) });
    }
    reg.placement = place;
    reg.rewarded = true;
    await reg.save();
    await notify({
      playerId: pid,
      type: "REWARD",
      title: place ? `You placed #${place} in ${t.name}` : `Thanks for playing ${t.name}`,
      body: `+${xpAmount} XP${coins ? ` · +${coins} coins` : ""}`,
      zoneId: String(t.zoneId),
    });
    results.push({ playerId: pid, place, xp: xpAmount, coins });
  }

  t.status = "completed";
  await t.save();
  emitToZone(String(t.zoneId), "tournament:results", { tournamentId, name: t.name });
  return { tournamentId, results };
}

/** Grant flat XP (tournament) and update level/rank snapshot. */
async function awardTournamentXp(playerId: string, xp: number) {
  const { Player } = await import("../../models/Player.js");
  const { levelForXp, rankForLevel } = await import("../xp/xp.service.js");
  const player = await Player.findById(playerId);
  if (!player) return null;
  player.xpTotal += xp;
  player.level = levelForXp(player.xpTotal);
  player.rank = rankForLevel(player.level);
  await player.save();
  return player;
}
