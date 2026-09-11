import { Schema, model, Types } from "mongoose";

const zoneSchema = new Schema(
  {
    ownerId: { type: Types.ObjectId, ref: "StaffUser", required: true, index: true },
    name: { type: String, required: true },
    country: { type: String, required: true },
    city: { type: String, required: true },
    currency: { type: String, default: "INR" },
    timezone: { type: String, default: "Asia/Kolkata" },
    verified: { type: Boolean, default: false },
    postpaidEnabled: { type: Boolean, default: false }, // trusted play, pay later
  },
  { timestamps: true }
);

export const Zone = model("Zone", zoneSchema);

const branchSchema = new Schema(
  {
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    name: { type: String, required: true },
    address: String,
    openingHours: Schema.Types.Mixed,
    rules: Schema.Types.Mixed,
  },
  { timestamps: true }
);

export const Branch = model("Branch", branchSchema);
