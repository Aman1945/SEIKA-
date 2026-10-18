import { Schema, model, Types } from "mongoose";

/**
 * A short numeric code shown on a PC's lock screen, typed into the player app
 * to attach to that PC.
 *
 * The QR holds a signed token, which needs no server state but cannot be read
 * by a human. A player with a cracked camera, a dirty screen or no camera
 * permission has no way in otherwise, and a gaming zone cannot tell them to
 * go home. So this is the same handshake with a code someone can read aloud.
 *
 * Because the code is short it cannot be self-verifying the way a JWT is —
 * there is nowhere to put a signature. It has to be stored and looked up, and
 * that is what makes the rest of this schema matter: a code is bound to one
 * PC, expires on the same one-minute cadence as the QR, and is single use.
 */
const pairingCodeSchema = new Schema(
  {
    code: { type: String, required: true },
    pcId: { type: Types.ObjectId, ref: "PC", required: true, index: true },
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    expiresAt: { type: Date, required: true },
    /** Set the moment it is redeemed, so a code works exactly once. */
    usedAt: { type: Date, default: null },
    usedBy: { type: Types.ObjectId, ref: "Player", default: null },
  },
  { timestamps: true }
);

/**
 * Unique only among codes that are still live.
 *
 * A full unique index would collide with every expired code ever issued and
 * eventually make issuing impossible. Mongo's TTL monitor runs about once a
 * minute, so expired rows linger; the partial filter keeps them out of the
 * uniqueness check while they do.
 */
pairingCodeSchema.index(
  { code: 1 },
  { name: "unique_live_code", unique: true, partialFilterExpression: { usedAt: null } }
);

/** Mongo removes the row once it expires; redemption checks the date anyway. */
pairingCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PairingCode = model("PairingCode", pairingCodeSchema);
