import { Schema, model, Types } from "mongoose";

const tournamentSchema = new Schema(
  {
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
  },
  { timestamps: true }
);

export const Tournament = model("Tournament", tournamentSchema);

const registrationSchema = new Schema(
  {
    tournamentId: { type: Types.ObjectId, ref: "Tournament", required: true, index: true },
    playerId: { type: Types.ObjectId, ref: "Player", required: true },
    paymentStatus: { type: String, enum: ["unpaid", "paid", "free"], default: "unpaid" },
    checkedIn: { type: Boolean, default: false },
    placement: Number, // 1 = winner
    rewarded: { type: Boolean, default: false },
  },
  { timestamps: true }
);

registrationSchema.index({ tournamentId: 1, playerId: 1 }, { unique: true });

export const TournamentRegistration = model("TournamentRegistration", registrationSchema);
