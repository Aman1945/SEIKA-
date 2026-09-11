import { Schema, model } from "mongoose";

/**
 * What Smart Sync is allowed to carry for one game.
 *
 * The policy lives here, on the server, not in the kiosk. The kiosk only
 * executes what this says — so "which folders may sync" is one auditable
 * decision an owner cannot accidentally widen from a PC, and so the rules are
 * testable without a Windows box.
 */
const gameSyncProfileSchema = new Schema(
  {
    game: { type: String, required: true, unique: true },
    /**
     * Relative paths, under the game's own save/config directory, that may
     * sync. Anything not matching one of these is refused (plan K5).
     */
    syncPaths: { type: [String], default: [] },
    /**
     * Paths inside the game's own directory that must never sync even though
     * they sit under an allowed root — anti-cheat state, hardware fingerprints,
     * signed manifests (plan K6). Touching these can get a player banned.
     */
    excludePaths: { type: [String], default: [] },
    /** Off by default: a game is syncable only once someone vets its paths. */
    enabled: { type: Boolean, default: false, index: true },
    notes: String,
  },
  { timestamps: true }
);

export const GameSyncProfile = model("GameSyncProfile", gameSyncProfileSchema);

/**
 * A player's stored config for one game. `payload` is opaque to SEIKA — the
 * kiosk packs the whitelisted files into it — and is versioned so two PCs
 * writing the same game surface a conflict instead of silently overwriting
 * (plan K4).
 */
const playerGameConfigSchema = new Schema(
  {
    playerId: { type: Schema.Types.ObjectId, ref: "Player", required: true, index: true },
    game: { type: String, required: true },
    /** Monotonic per player+game. A write must name the version it is based on. */
    version: { type: Number, required: true, default: 1 },
    payload: { type: String, required: true },
    /** Which PC last wrote it, so a conflict can name the other machine. */
    pcId: { type: Schema.Types.ObjectId, ref: "PC" },
    zoneId: { type: Schema.Types.ObjectId, ref: "Zone" },
    sizeBytes: Number,
    /** Files the kiosk reported and the server refused, kept for support. */
    rejectedPaths: { type: [String], default: [] },
  },
  { timestamps: true }
);

playerGameConfigSchema.index({ playerId: 1, game: 1 }, { unique: true });

export const PlayerGameConfig = model("PlayerGameConfig", playerGameConfigSchema);
