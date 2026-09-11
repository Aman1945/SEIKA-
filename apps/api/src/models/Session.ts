import { Schema, model, Types } from "mongoose";
import { SessionStatus, PaymentSource } from "./enums.js";

const sessionSchema = new Schema(
  {
    playerId: { type: Types.ObjectId, ref: "Player", required: true, index: true },
    pcId: { type: Types.ObjectId, ref: "PC", required: true, index: true },
    branchId: { type: Types.ObjectId, ref: "Branch", required: true, index: true },
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    startTime: Date,
    endTime: Date,
    validMinutes: { type: Number, default: 0 }, // XP-eligible minutes only
    cost: { type: Schema.Types.Decimal128, default: 0 },
    status: { type: String, enum: SessionStatus, default: "PENDING_AUTH", index: true },
    paymentSource: { type: String, enum: PaymentSource },
    sessionMode: { type: String, enum: ["FIXED_DURATION", "OPEN_HOUR"], default: "OPEN_HOUR" },
    selectedMinutes: Number, // 60 / 120 / 180 for FIXED_DURATION; null for OPEN_HOUR
    pricingSnapshot: Schema.Types.Mixed, // rate rules frozen at start
    endReason: String, // time_completed / player_ended / staff_ended / insufficient_balance / refund
    xpAwarded: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Guard: only one non-terminal session per PC at a time (enforced in service too).
sessionSchema.index(
  { pcId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["PENDING_AUTH", "AUTHORIZED", "ACTIVE", "PAUSED", "LOW_BALANCE"] },
    },
  }
);

export const Session = model("Session", sessionSchema);
