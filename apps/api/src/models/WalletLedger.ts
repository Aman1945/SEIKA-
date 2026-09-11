import { Schema, model, Types } from "mongoose";
import { WalletTxnType } from "./enums.js";

/**
 * Real-money wallet ledger. APPEND-ONLY.
 * Balance is ALWAYS computed as SUM(amount) — never stored/edited directly.
 * amount: positive = credit, negative = debit. Uses Decimal128 (never float).
 */
const walletLedgerSchema = new Schema(
  {
    playerId: { type: Types.ObjectId, ref: "Player", required: true, index: true },
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    type: { type: String, enum: WalletTxnType, required: true },
    method: { type: String, enum: ["CASH", "CARD", "GATEWAY", "WALLET"], required: true },
    reference: String, // razorpay id, session id, etc.
    status: { type: String, default: "confirmed" },
    createdBy: { type: String, required: true }, // staff/system actor id
  },
  { timestamps: true }
);

walletLedgerSchema.index({ playerId: 1, createdAt: -1 });

export const WalletLedger = model("WalletLedger", walletLedgerSchema);
