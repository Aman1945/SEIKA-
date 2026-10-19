import { Session } from "../../models/Session.js";
import { PC } from "../../models/PC.js";
import { badRequest, notFound } from "../../common/errors.js";
import { withTransaction } from "../../config/db.js";
import { addWalletEntry } from "../wallet/wallet.service.js";
import { awardSessionXp, reverseXp } from "../xp/xp.service.js";
import { CoinLedger } from "../../models/CoinLedger.js";
import { emitToZone, emitToPc } from "../realtime/io.js";
import { notify } from "../notification/notification.service.js";

/** AUTHORIZED → ACTIVE: unlock the PC and start the timer. */
export async function startSession(sessionId: string) {
  const session = await Session.findById(sessionId);
  if (!session) throw notFound("Session not found");
  if (session.status !== "AUTHORIZED")
    throw badRequest(`Session is ${session.status}, must be AUTHORIZED to start`);

  session.status = "ACTIVE";
  session.startTime = new Date();
  await session.save();

  await PC.findByIdAndUpdate(session.pcId, { status: "OCCUPIED" });

  // The launcher on the PC needs enough to render itself without a second
  // round trip: how long the player has, and whether it is counting down to a
  // fixed end or running open-ended. It computes the clock from endsAt rather
  // than being told the remaining seconds, so a slow message does not make
  // the timer wrong.
  const endsAt =
    session.sessionMode === "FIXED_DURATION" && session.selectedMinutes
      ? new Date(session.startTime.getTime() + session.selectedMinutes * 60_000)
      : null;

  emitToPc(String(session.pcId), "command", {
    action: "unlock",
    sessionId,
    startedAt: session.startTime,
    endsAt,
    sessionMode: session.sessionMode,
    selectedMinutes: session.selectedMinutes ?? null,
  });
  emitToZone(String(session.zoneId), "session:update", {
    sessionId,
    pcId: String(session.pcId),
    status: "ACTIVE",
    startTime: session.startTime,
  });
  emitToZone(String(session.zoneId), "pc:status", { pcId: String(session.pcId), status: "OCCUPIED" });
  return session;
}

/**
 * End a session: compute valid minutes, deduct cost from wallet (money-safe txn),
 * mark PC available, then award XP. XP only from valid gameplay minutes.
 */
export async function endSession(sessionId: string) {
  const session = await Session.findById(sessionId);
  if (!session) throw notFound("Session not found");
  if (!["ACTIVE", "PAUSED", "LOW_BALANCE"].includes(session.status))
    throw badRequest(`Session is ${session.status}, cannot end`);

  const end = new Date();
  const start = session.startTime ?? end;
  const validMinutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const rate = (session.pricingSnapshot as { hourlyRate?: number })?.hourlyRate ?? 0;
  // VOUCHER / PACKAGE are free play (covered elsewhere) → no wallet cost.
  const free = session.paymentSource === "VOUCHER" || session.paymentSource === "PACKAGE";
  // FIXED_DURATION bills the selected block (1/2/3h); OPEN_HOUR meters actual minutes.
  const billedMinutes =
    session.sessionMode === "FIXED_DURATION" && session.selectedMinutes
      ? session.selectedMinutes
      : validMinutes;
  const cost = free ? 0 : +((rate * billedMinutes) / 60).toFixed(2);
  session.endReason =
    session.sessionMode === "FIXED_DURATION" && validMinutes >= (session.selectedMinutes ?? 0)
      ? "time_completed"
      : "player_ended";

  // Money-safe: wallet deduction + session completion commit or roll back together.
  await withTransaction(async (txn) => {
    if (session.paymentSource === "PACKAGE" && validMinutes > 0) {
      // Consume package minutes instead of charging the wallet.
      const { PlayerPackage } = await import("../../models/PlayerPackage.js");
      const pkg = await PlayerPackage.findOne({
        playerId: session.playerId,
        zoneId: session.zoneId,
        active: true,
        minutesRemaining: { $gt: 0 },
      }).session(txn);
      if (pkg) {
        pkg.minutesRemaining = Math.max(0, pkg.minutesRemaining - validMinutes);
        if (pkg.minutesRemaining === 0) pkg.active = false;
        await pkg.save({ session: txn });
      }
    }
    if ((session.paymentSource === "WALLET" || session.paymentSource === "POSTPAID") && cost > 0) {
      await addWalletEntry(
        {
          playerId: String(session.playerId),
          zoneId: String(session.zoneId),
          amount: -cost,
          type: "DEDUCT",
          method: "WALLET",
          reference: `session:${sessionId}`,
          createdBy: "system",
        },
        txn
      );
    }
    session.status = "COMPLETED";
    session.endTime = end;
    session.validMinutes = validMinutes;
    session.cost = cost as unknown as typeof session.cost;
    await session.save({ session: txn });
    await PC.findByIdAndUpdate(session.pcId, { status: "AVAILABLE" }, { session: txn });
  });

  // XP is not money — safe to award after the financial transaction commits.
  const xp = await awardSessionXp(String(session.playerId), validMinutes, {
    sessionId: String(session._id),
    zoneId: String(session.zoneId),
  });
  session.xpAwarded = xp.gained;
  await session.save();

  if (xp.leveledUp) {
    emitToZone(String(session.zoneId), "player:levelup", {
      playerId: String(session.playerId),
      level: xp.level,
      rank: xp.rank,
      ranksUnlocked: xp.ranksUnlocked,
      coinsAwarded: xp.coinsAwarded,
    });
    await notify({
      playerId: String(session.playerId),
      type: "LEVELUP",
      title: `Level up! You're now level ${xp.level}`,
      body: `${xp.rank}${xp.coinsAwarded ? ` · +${xp.coinsAwarded} coins` : ""}`,
      zoneId: String(session.zoneId),
    });
  }

  emitToPc(String(session.pcId), "command", { action: "lock", sessionId });
  emitToZone(String(session.zoneId), "session:update", {
    sessionId,
    pcId: String(session.pcId),
    status: "COMPLETED",
    validMinutes,
    cost,
    xp,
  });
  emitToZone(String(session.zoneId), "pc:status", { pcId: String(session.pcId), status: "AVAILABLE" });

  return { session, validMinutes, cost, xp };
}

/**
 * Refund a completed session: credit the wallet back, reverse awarded XP and
 * any coins earned from it. Blueprint rule: refund reverses XP + coins.
 */
export async function refundSession(sessionId: string, actorId: string, reason?: string) {
  const session = await Session.findById(sessionId);
  if (!session) throw notFound("Session not found");
  if (session.status !== "COMPLETED") throw badRequest(`Session is ${session.status}, cannot refund`);

  const cost = parseFloat(String(session.cost));
  const xpToReverse = session.xpAwarded ?? 0;

  await withTransaction(async (txn) => {
    if (cost > 0 && (session.paymentSource === "WALLET" || session.paymentSource === "POSTPAID")) {
      await addWalletEntry(
        {
          playerId: String(session.playerId),
          zoneId: String(session.zoneId),
          amount: cost, // credit back
          type: "REFUND",
          method: "WALLET",
          reference: `session-refund:${sessionId}`,
          createdBy: actorId,
        },
        txn
      );
    }
    if (xpToReverse > 0) await reverseXp(String(session.playerId), xpToReverse, txn);
    // reverse any coins tied to this session
    const coins = await CoinLedger.find({ sourceId: sessionId, type: { $ne: "REVERSAL" } }).session(txn);
    for (const c of coins) {
      await CoinLedger.create(
        [{ playerId: c.playerId, amount: -c.amount, type: "REVERSAL", reason: `refund:${sessionId}`, sourceId: sessionId }],
        { session: txn }
      );
    }
    session.status = "REFUNDED";
    await session.save({ session: txn });
  });

  emitToZone(String(session.zoneId), "session:update", { sessionId, status: "REFUNDED", refundedAmount: cost });
  return { sessionId, refundedAmount: cost, xpReversed: xpToReverse, reason };
}
