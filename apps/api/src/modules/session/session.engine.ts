import mongoose from "mongoose";
import { Session } from "../../models/Session.js";
import { PC } from "../../models/PC.js";
import { Booking } from "../../models/Booking.js";
import type { PaymentSource } from "../../models/enums.js";
import { badRequest, conflict, forbidden, notFound } from "../../common/errors.js";
import { getWalletBalance } from "../wallet/wallet.service.js";

/** Minimum minutes a player must be able to afford to start a session. */
const MIN_START_MINUTES = 15;

export interface AuthorizeResult {
  authorized: boolean;
  reason?: string;
  source?: PaymentSource;
  minStartAmount?: number;
  balance?: number;
  sessionMode?: "FIXED_DURATION" | "OPEN_HOUR";
}

/**
 * THE core rule: QR login attaches identity only. This engine decides whether
 * a PC may unlock, based on a valid payment source. Never unlock on identity alone.
 */
export async function authorizeSession(
  sessionId: string,
  source: PaymentSource,
  ctx: {
    staffApproved?: boolean;
    voucherCode?: string;
    sessionMode?: "FIXED_DURATION" | "OPEN_HOUR";
    selectedMinutes?: number;
  } = {}
): Promise<AuthorizeResult> {
  const session = await Session.findById(sessionId);
  if (!session) throw notFound("Session not found");
  if (session.status !== "PENDING_AUTH")
    throw badRequest(`Session is ${session.status}, cannot authorize`);

  const pc = await PC.findById(session.pcId);
  if (!pc) throw notFound("PC not found");
  const rate = parseFloat(pc.hourlyRate.toString());

  // Play mode: FIXED_DURATION (1h/2h/3h) charges for the block; OPEN_HOUR meters
  // per minute but needs a minimum start balance/deposit.
  const mode = ctx.sessionMode ?? "OPEN_HOUR";
  if (mode === "FIXED_DURATION" && ![60, 120, 180].includes(ctx.selectedMinutes ?? 0)) {
    throw badRequest("FIXED_DURATION requires selectedMinutes of 60, 120, or 180");
  }
  const requiredForFixed = +((rate * (ctx.selectedMinutes ?? 0)) / 60).toFixed(2);
  const minStartAmount =
    mode === "FIXED_DURATION" ? requiredForFixed : +((rate * MIN_START_MINUTES) / 60).toFixed(2);

  switch (source) {
    case "WALLET": {
      const balance = await getWalletBalance(String(session.playerId), String(session.zoneId));
      if (balance < minStartAmount) {
        return { authorized: false, reason: "INSUFFICIENT_BALANCE", minStartAmount, balance };
      }
      break;
    }
    case "CASH": {
      if (!ctx.staffApproved) throw forbidden("Cash start requires cashier approval");
      break;
    }
    case "BOOKING": {
      const now = new Date();
      const booking = await Booking.findOne({
        playerId: session.playerId,
        pcId: session.pcId,
        paymentStatus: "paid",
        status: "confirmed",
        slotStart: { $lte: now },
        slotEnd: { $gte: now },
      });
      if (!booking) return { authorized: false, reason: "NO_VALID_BOOKING" };
      booking.status = "completed";
      await booking.save();
      break;
    }
    case "POSTPAID": {
      if (!ctx.staffApproved) throw forbidden("Postpaid requires staff approval");
      const { Zone } = await import("../../models/Zone.js");
      const zone = await Zone.findById(session.zoneId);
      if (!zone?.postpaidEnabled) return { authorized: false, reason: "POSTPAID_DISABLED" };
      // Accrue a due balance; cost is deducted (may go negative = due) at end.
      break;
    }
    case "VOUCHER": {
      if (!ctx.voucherCode) return { authorized: false, reason: "VOUCHER_CODE_REQUIRED" };
      const { Voucher } = await import("../../models/Voucher.js");
      const v = await Voucher.findOne({
        zoneId: session.zoneId,
        code: ctx.voucherCode.toUpperCase(),
        active: true,
      });
      if (!v) return { authorized: false, reason: "VOUCHER_INVALID" };
      if (v.validUntil && v.validUntil < new Date()) return { authorized: false, reason: "VOUCHER_EXPIRED" };
      if (v.redeemed >= v.maxRedemptions) return { authorized: false, reason: "VOUCHER_EXHAUSTED" };
      // Atomically claim one redemption.
      const claim = await Voucher.updateOne(
        { _id: v._id, redeemed: { $lt: v.maxRedemptions } },
        { $inc: { redeemed: 1 } }
      );
      if (claim.modifiedCount !== 1) return { authorized: false, reason: "VOUCHER_EXHAUSTED" };
      // Free play → cost stays 0 (endSession only deducts WALLET/POSTPAID).
      break;
    }
    case "PACKAGE": {
      const { PlayerPackage } = await import("../../models/PlayerPackage.js");
      const pkg = await PlayerPackage.findOne({
        playerId: session.playerId,
        zoneId: session.zoneId,
        active: true,
        minutesRemaining: { $gt: 0 },
      });
      if (!pkg) return { authorized: false, reason: "NO_ACTIVE_PACKAGE" };
      break;
    }
  }

  session.status = "AUTHORIZED";
  session.paymentSource = source;
  session.sessionMode = mode;
  session.selectedMinutes = mode === "FIXED_DURATION" ? ctx.selectedMinutes : undefined;
  session.pricingSnapshot = {
    hourlyRate: rate,
    sessionMode: mode,
    selectedMinutes: mode === "FIXED_DURATION" ? ctx.selectedMinutes : null,
    minimumStartBalance: minStartAmount,
  };
  await session.save();

  return { authorized: true, source, minStartAmount, sessionMode: mode };
}

/** Attach a player to a PC via QR → creates a PENDING_AUTH session (0 XP, PC stays locked). */
export async function attachPlayer(pcId: string, playerId: string) {
  const pc = await PC.findById(pcId);
  if (!pc) throw notFound("PC not found");
  if (pc.status === "MAINTENANCE" || pc.status === "OFFLINE")
    throw conflict(`PC is ${pc.status}`);

  try {
    const session = await Session.create({
      playerId,
      pcId: pc._id,
      branchId: pc.branchId,
      zoneId: pc.zoneId,
      status: "PENDING_AUTH",
    });
    return session;
  } catch (err) {
    // partial-unique index on {pcId, non-terminal status} → PC already busy
    if ((err as { code?: number }).code === 11000) throw conflict("PC already has an active session");
    throw err;
  }
}
