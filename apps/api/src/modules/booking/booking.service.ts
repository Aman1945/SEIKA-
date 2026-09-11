import crypto from "node:crypto";
import mongoose from "mongoose";
import { Booking } from "../../models/Booking.js";
import { PC } from "../../models/PC.js";
import { badRequest, conflict, forbidden, notFound } from "../../common/errors.js";
import { withTransaction } from "../../config/db.js";
import { addWalletEntry, getWalletBalance } from "../wallet/wallet.service.js";

/** Staff roles allowed to act on a booking on a player's behalf. */
const BOOKING_STAFF_ROLES = ["SUPER_ADMIN", "ZONE_OWNER", "BRANCH_MANAGER", "CASHIER"];

/**
 * A booking may only be acted on by the player who made it, or by staff of that
 * booking's own zone holding a permitted role. Without this, any authenticated
 * player could cancel a stranger's reserved seat — or trigger a wallet debit
 * against them — just by knowing the booking id.
 */
function assertMayActOnBooking(
  booking: { playerId: unknown; zoneId: unknown },
  actor: { id: string; type: "player" | "staff"; role?: string; zoneId?: string }
): void {
  if (actor.type === "player") {
    if (String(booking.playerId) !== actor.id) throw forbidden("Not your booking");
    return;
  }
  const sameZone = actor.role === "SUPER_ADMIN" || String(booking.zoneId) === actor.zoneId;
  if (!sameZone) throw forbidden("Booking belongs to another zone");
  if (!BOOKING_STAFF_ROLES.includes(actor.role ?? "")) {
    throw forbidden("Role cannot act on bookings");
  }
}

/** Overlap test: existing.start < newEnd AND existing.end > newStart. */
async function hasConflict(
  pcId: string,
  start: Date,
  end: Date,
  session: mongoose.ClientSession
): Promise<boolean> {
  const clash = await Booking.findOne({
    pcId,
    status: "confirmed",
    slotStart: { $lt: end },
    slotEnd: { $gt: start },
  }).session(session);
  return Boolean(clash);
}

/** Create a booking with race-safe conflict detection inside a transaction. */
export async function createBooking(params: {
  playerId: string;
  pcId: string;
  slotStart: Date;
  slotEnd: Date;
}) {
  if (params.slotEnd <= params.slotStart) throw badRequest("slotEnd must be after slotStart");
  const pc = await PC.findById(params.pcId);
  if (!pc) throw notFound("PC not found");

  const rate = parseFloat(pc.hourlyRate.toString());
  const minutes = Math.round((params.slotEnd.getTime() - params.slotStart.getTime()) / 60000);
  const amount = +((rate * minutes) / 60).toFixed(2);

  return withTransaction(async (txn) => {
    if (await hasConflict(params.pcId, params.slotStart, params.slotEnd, txn)) {
      throw conflict("PC already booked for an overlapping slot");
    }
    const [booking] = await Booking.create(
      [
        {
          playerId: params.playerId,
          pcId: pc._id,
          branchId: pc.branchId,
          zoneId: pc.zoneId,
          slotStart: params.slotStart,
          slotEnd: params.slotEnd,
          amount: mongoose.Types.Decimal128.fromString(amount.toFixed(2)),
          qrCode: `bk_${crypto.randomBytes(10).toString("hex")}`,
        },
      ],
      { session: txn }
    );
    return booking;
  });
}

/**
 * Pay for a booking from the player's wallet (money-safe).
 *
 * The debit always lands on the booking's own player, so the actor must be that
 * player or staff of the booking's zone — otherwise a stranger could trigger
 * debits against someone else's wallet.
 */
export async function payBookingFromWallet(
  bookingId: string,
  actor: { id: string; type: "player" | "staff"; role?: string; zoneId?: string }
) {
  const booking = await Booking.findById(bookingId);
  if (!booking) throw notFound("Booking not found");
  assertMayActOnBooking(booking, actor);
  if (booking.paymentStatus === "paid") throw badRequest("Already paid");
  const amount = parseFloat(booking.amount.toString());
  const balance = await getWalletBalance(String(booking.playerId), String(booking.zoneId));
  if (balance < amount) throw badRequest(`Insufficient balance (need ₹${amount}, have ₹${balance})`);

  await withTransaction(async (txn) => {
    await addWalletEntry(
      {
        playerId: String(booking.playerId),
        zoneId: String(booking.zoneId),
        amount: -amount,
        type: "BOOKING",
        method: "WALLET",
        reference: `booking:${bookingId}`,
        createdBy: actor.id,
      },
      txn
    );
    booking.paymentStatus = "paid";
    await booking.save({ session: txn });
  });
  return booking;
}

/** Check in via QR at the venue. Returns the booking if valid + in window. */
export async function checkinBooking(qrCode: string) {
  const booking = await Booking.findOne({ qrCode });
  if (!booking) throw notFound("Booking not found");
  if (booking.paymentStatus !== "paid") throw badRequest("Booking not paid");
  if (booking.status !== "confirmed") throw badRequest(`Booking is ${booking.status}`);
  const now = new Date();
  // grace: allow check-in from 10 min before slot start until slot end
  if (now < new Date(booking.slotStart.getTime() - 10 * 60000) || now > booking.slotEnd) {
    throw badRequest("Outside check-in window");
  }
  return booking;
}

/** Cancel a booking; refund to wallet if it was paid. */
export async function cancelBooking(
  bookingId: string,
  actor: { id: string; type: "player" | "staff"; role?: string; zoneId?: string }
) {
  const booking = await Booking.findById(bookingId);
  if (!booking) throw notFound("Booking not found");
  assertMayActOnBooking(booking, actor);
  if (booking.status !== "confirmed") throw badRequest(`Cannot cancel a ${booking.status} booking`);

  const amount = parseFloat(booking.amount.toString());
  await withTransaction(async (txn) => {
    if (booking.paymentStatus === "paid" && amount > 0) {
      await addWalletEntry(
        {
          // Always refunds the player who paid, never the actor.
          playerId: String(booking.playerId),
          zoneId: String(booking.zoneId),
          amount, // credit back
          type: "REFUND",
          method: "WALLET",
          reference: `booking-cancel:${bookingId}`,
          createdBy: actor.id,
        },
        txn
      );
    }
    booking.status = "cancelled";
    await booking.save({ session: txn });
  });
  return booking;
}
