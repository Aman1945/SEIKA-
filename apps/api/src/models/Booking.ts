import { Schema, model, Types } from "mongoose";

const bookingSchema = new Schema(
  {
    playerId: { type: Types.ObjectId, ref: "Player", required: true, index: true },
    pcId: { type: Types.ObjectId, ref: "PC", required: true, index: true },
    branchId: { type: Types.ObjectId, ref: "Branch", required: true },
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    slotStart: { type: Date, required: true },
    slotEnd: { type: Date, required: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    status: {
      type: String,
      enum: ["confirmed", "cancelled", "noshow", "completed"],
      default: "confirmed",
    },
    paymentStatus: { type: String, enum: ["unpaid", "paid"], default: "unpaid" },
    qrCode: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

// Conflict detection support (overlap check done in service inside a transaction).
bookingSchema.index({ pcId: 1, slotStart: 1, slotEnd: 1 });

export const Booking = model("Booking", bookingSchema);
