import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler.js";
import { badRequest, forbidden } from "../../common/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  createBooking,
  payBookingFromWallet,
  checkinBooking,
  cancelBooking,
} from "./booking.service.js";
import { Booking } from "../../models/Booking.js";
import { audit } from "../audit/audit.service.js";

export const bookingRouter = Router();
bookingRouter.use(requireAuth);

/** Player reserves a seat (conflict-checked). */
bookingRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw forbidden("Players only");
    const body = z
      .object({
        pcId: z.string(),
        slotStart: z.coerce.date(),
        slotEnd: z.coerce.date(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest("Invalid body", body.error.flatten());
    const booking = await createBooking({ playerId: req.auth!.sub, ...body.data });
    res.status(201).json({
      ok: true,
      bookingId: String(booking._id),
      amount: parseFloat(booking.amount.toString()),
      qrCode: booking.qrCode,
      paymentStatus: booking.paymentStatus,
    });
  })
);

bookingRouter.post(
  "/:id/pay",
  asyncHandler(async (req, res) => {
    const booking = await payBookingFromWallet(req.params.id, req.auth!.sub);
    res.json({ ok: true, bookingId: String(booking._id), paymentStatus: booking.paymentStatus });
  })
);

/** Check in with the booking QR (kiosk/staff). */
bookingRouter.post(
  "/checkin",
  asyncHandler(async (req, res) => {
    const { qrCode } = z.object({ qrCode: z.string() }).parse(req.body);
    const booking = await checkinBooking(qrCode);
    res.json({
      ok: true,
      bookingId: String(booking._id),
      playerId: String(booking.playerId),
      pcId: String(booking.pcId),
    });
  })
);

bookingRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    const booking = await cancelBooking(req.params.id, req.auth!.sub);
    await audit({
      actorId: req.auth!.sub,
      actorType: req.auth!.typ,
      action: "BOOKING_CANCEL",
      entityType: "booking",
      entityId: req.params.id,
    });
    res.json({ ok: true, status: booking.status });
  })
);

bookingRouter.get(
  "/mine",
  asyncHandler(async (req, res) => {
    if (req.auth!.typ !== "player") throw forbidden("Players only");
    const rows = await Booking.find({ playerId: req.auth!.sub }).sort({ slotStart: -1 }).limit(50).lean();
    res.json({ ok: true, bookings: rows });
  })
);
