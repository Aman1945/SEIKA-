import { Schema, model, Types } from "mongoose";

/** Free-play / discount voucher redeemable at session authorization. */
const voucherSchema = new Schema(
  {
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    code: { type: String, required: true, uppercase: true },
    type: { type: String, enum: ["FREE_MINUTES"], default: "FREE_MINUTES" },
    value: { type: Number, required: true }, // free minutes
    validUntil: Date,
    maxRedemptions: { type: Number, default: 1 },
    redeemed: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

voucherSchema.index({ zoneId: 1, code: 1 }, { unique: true });

export const Voucher = model("Voucher", voucherSchema);
