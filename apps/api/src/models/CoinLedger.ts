import { Schema, model, Types } from "mongoose";
import { CoinTxnType } from "./enums.js";

/**
 * SEIKA Coin (loyalty points) ledger. APPEND-ONLY. Separate from wallet money.
 * Coins are NOT withdrawable as cash. amount: + earn / - spend.
 */
const coinLedgerSchema = new Schema(
  {
    playerId: { type: Types.ObjectId, ref: "Player", required: true, index: true },
    amount: { type: Number, required: true },
    type: { type: String, enum: CoinTxnType, required: true },
    reason: { type: String, required: true },
    sourceId: String,
    zoneId: { type: Types.ObjectId, ref: "Zone" },
  },
  { timestamps: true }
);

coinLedgerSchema.index({ playerId: 1, createdAt: -1 });

export const CoinLedger = model("CoinLedger", coinLedgerSchema);
