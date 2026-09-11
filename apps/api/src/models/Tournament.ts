import { Schema, model, Types } from "mongoose";

/** Where a cross-zone participant stands in the co-hosting handshake. */
export const ParticipantStatus = ["invited", "accepted", "declined"] as const;
export type ParticipantStatus = (typeof ParticipantStatus)[number];

export const VerificationStatus = ["pending", "verified", "disputed"] as const;
export type VerificationStatus = (typeof VerificationStatus)[number];

const tournamentSchema = new Schema(
  {
    /** The host zone. For a single-zone event this is the only zone involved. */
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    name: { type: String, required: true },
    game: String,
    startAt: Date,
    entryFee: { type: Schema.Types.Decimal128, default: 0 },
    prize: String,
    maxPlayers: { type: Number, default: 16 },
    xpReward: { type: Number, default: 500 }, // base XP for participation
    winnerCoins: { type: Number, default: 1000 },
    status: {
      type: String,
      enum: ["upcoming", "registration", "live", "completed", "cancelled"],
      default: "registration",
    },

    // ─── Cross-zone (plan module J) ─────────────────────────────────────────
    /** True once a second zone is invited; drives the co-hosting rules. */
    crossZone: { type: Boolean, default: false, index: true },
    /**
     * Co-hosts. The host zone is NOT listed here — it is `zoneId`. A zone can
     * only be invited if an accepted ZoneConnection exists with the host.
     */
    participatingZones: {
      type: [
        {
          zoneId: { type: Types.ObjectId, ref: "Zone", required: true },
          status: { type: String, enum: ParticipantStatus, default: "invited" },
          invitedAt: { type: Date, default: Date.now },
          respondedBy: String,
          respondedAt: Date,
        },
      ],
      default: [],
    },
    /**
     * Prize pool split by placement, as percentages of the pooled entry fees.
     * Percentages are validated to total at most 100 when the event is created.
     */
    prizeSplit: {
      type: [{ place: { type: Number, required: true }, percent: { type: Number, required: true } }],
      default: [],
    },
    /** Share of the host's platform cut each zone keeps, percent of the pool. */
    revenueSplit: {
      type: [{ zoneId: { type: Types.ObjectId, ref: "Zone" }, percent: Number }],
      default: [],
    },
    /**
     * Placements as submitted by each participating zone. A cross-zone payout
     * requires every accepted zone to submit, and all submissions to agree
     * (plan J9) — one zone's word is not enough to move other zones' money.
     */
    resultSubmissions: {
      type: [
        {
          zoneId: { type: Types.ObjectId, ref: "Zone", required: true },
          placements: { type: [{ playerId: String, place: Number }], default: [] },
          submittedBy: String,
          submittedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    verificationStatus: { type: String, enum: VerificationStatus, default: "pending" },
    /** Open and resolved disputes. Any open dispute blocks the payout. */
    disputes: {
      type: [
        {
          zoneId: { type: Types.ObjectId, ref: "Zone", required: true },
          raisedBy: String,
          reason: String,
          raisedAt: { type: Date, default: Date.now },
          resolvedBy: String,
          resolvedAt: Date,
          resolution: String,
        },
      ],
      default: [],
    },
    /** Computed at payout: pooled fees, prize amounts, per-zone shares. */
    settlement: Schema.Types.Mixed,
  },
  { timestamps: true }
);

export const Tournament = model("Tournament", tournamentSchema);

const registrationSchema = new Schema(
  {
    tournamentId: { type: Types.ObjectId, ref: "Tournament", required: true, index: true },
    playerId: { type: Types.ObjectId, ref: "Player", required: true },
    /**
     * The zone the player registered through, and therefore the wallet the
     * entry fee came out of. Cross-zone players each pay in their own zone
     * (plan J7), so the fee never crosses a tenant boundary.
     */
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    paymentStatus: { type: String, enum: ["unpaid", "paid", "free"], default: "unpaid" },
    checkedIn: { type: Boolean, default: false },
    /** Zone the player physically checked in at (plan J8). */
    checkedInZoneId: { type: Types.ObjectId, ref: "Zone" },
    checkedInAt: Date,
    placement: Number, // 1 = winner
    rewarded: { type: Boolean, default: false },
  },
  { timestamps: true }
);

registrationSchema.index({ tournamentId: 1, playerId: 1 }, { unique: true });

export const TournamentRegistration = model("TournamentRegistration", registrationSchema);
