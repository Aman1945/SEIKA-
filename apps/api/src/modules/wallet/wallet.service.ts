import mongoose from "mongoose";
import { WalletLedger } from "../../models/WalletLedger.js";
import type { WalletTxnType } from "../../models/enums.js";

/** Wallet balance = SUM(ledger). NEVER stored/edited directly. */
export async function getWalletBalance(playerId: string, zoneId?: string): Promise<number> {
  const match: Record<string, unknown> = { playerId: new mongoose.Types.ObjectId(playerId) };
  if (zoneId) match.zoneId = new mongoose.Types.ObjectId(zoneId);
  const rows = await WalletLedger.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: { $toDecimal: "$amount" } } } },
  ]);
  if (!rows.length) return 0;
  return parseFloat(rows[0].total.toString());
}

export interface LedgerInput {
  playerId: string;
  zoneId: string;
  amount: number; // + credit / - debit
  type: WalletTxnType;
  method: "CASH" | "CARD" | "GATEWAY" | "WALLET";
  reference?: string;
  createdBy: string;
}

/** Append a ledger entry. Pass a session to run inside a transaction (money-safe). */
export async function addWalletEntry(
  input: LedgerInput,
  session?: mongoose.ClientSession
) {
  const doc = {
    ...input,
    amount: mongoose.Types.Decimal128.fromString(input.amount.toFixed(2)),
  };
  const [created] = await WalletLedger.create([doc], session ? { session } : {});
  return created;
}
