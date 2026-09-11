import { Schema, model } from "mongoose";

/**
 * Rotating refresh tokens. We store only the hash of the token.
 * On refresh, the old token is revoked and a new one issued (rotation).
 */
const refreshTokenSchema = new Schema({
  subjectId: { type: String, required: true, index: true }, // player or staff id
  subjectType: { type: String, enum: ["player", "staff"], required: true },
  tokenHash: { type: String, required: true, index: true },
  revoked: { type: Boolean, default: false },
  replacedBy: String,
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = model("RefreshToken", refreshTokenSchema);
