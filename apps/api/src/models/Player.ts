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
    country: String,
    city: String,
    status: { type: String, default: "active" },
    // progression snapshot (source of truth = ledgers/session history)
    xpTotal: { type: Number, default: 0 },
    level: { type: Number, default: 1 },
    rank: { type: String, default: "Rookie" },
  },
  { timestamps: true }
);

export const Player = model("Player", playerSchema);
