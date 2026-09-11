import { Schema, model, Types } from "mongoose";

/** Prepaid playtime package owned by a player (e.g. bought a 5-hour pack). */
const playerPackageSchema = new Schema(
  {
    playerId: { type: Types.ObjectId, ref: "Player", required: true, index: true },
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    minutesRemaining: { type: Number, required: true },
    active: { type: Boolean, default: true },
    source: { type: String, default: "granted" }, // granted / purchased
  },
  { timestamps: true }
);

export const PlayerPackage = model("PlayerPackage", playerPackageSchema);
