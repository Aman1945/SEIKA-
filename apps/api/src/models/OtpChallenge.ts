import { Schema, model } from "mongoose";

/**
 * OTP challenges. Stored with a TTL index so expired ones auto-delete.
 * codeHash is bcrypt-hashed — plain OTP is never stored.
 * (Moves to Redis in P6 for rate-limiting; MongoDB TTL is fine for P1.)
 */
const otpChallengeSchema = new Schema({
  identifier: { type: String, required: true, index: true }, // phone or email
  channel: { type: String, enum: ["phone", "email"], required: true },
  audience: { type: String, enum: ["player", "staff"], default: "player" },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});

// TTL index: document removed when expiresAt passes.
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpChallenge = model("OtpChallenge", otpChallengeSchema);
