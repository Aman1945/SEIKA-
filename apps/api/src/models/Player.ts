import { Schema, model } from "mongoose";

const playerSchema = new Schema(
  {
    name: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    phone: { type: String, unique: true, sparse: true },
    email: { type: String, unique: true, sparse: true },
    googleId: { type: String, unique: true, sparse: true },
    otpVerified: { type: Boolean, default: false },
    avatar: String,
    /** Public display handle, shown on leaderboards and the PC login screen. */
    gamerTag: { type: String, trim: true },
    country: String,
    city: String,
    /** Region is derived from country so geo leaderboards can group by it. */
    region: String,
    favoriteGames: { type: [String], default: [] },
    status: { type: String, default: "active" },
    /** Provenance for players brought over from a previous system. */
    importedFrom: String,
    importedAt: Date,
    /** Stats carried over from the old tool — reference only, never scored. */
    legacy: {
      membership: String,
      playedHours: Number,
      sessionsCount: Number,
    },
    // progression snapshot (source of truth = ledgers/session history)
    xpTotal: { type: Number, default: 0 },
    level: { type: Number, default: 1 },
    rank: { type: String, default: "Rookie" },
  },
  { timestamps: true }
);

export const Player = model("Player", playerSchema);
