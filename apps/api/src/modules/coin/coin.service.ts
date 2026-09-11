import mongoose from "mongoose";
import { CoinLedger } from "../../models/CoinLedger.js";
import type { CoinTxnType } from "../../models/enums.js";

/** SEIKA Coin balance = SUM(coin ledger). Loyalty points, not withdrawable cash. */
export async function getCoinBalance(playerId: string): Promise<number> {
  const rows = await CoinLedger.aggregate([
    { $match: { playerId: new mongoose.Types.ObjectId(playerId) } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return rows[0]?.total ?? 0;
}

export async function grantCoins(
  params: {
    playerId: string;
    amount: number;
    type: CoinTxnType;
    reason: string;
    sourceId?: string;
    zoneId?: string;
  },
  session?: mongoose.ClientSession
) {
  const [doc] = await CoinLedger.create(
    [
      {
        playerId: new mongoose.Types.ObjectId(params.playerId),
        amount: params.amount,
        type: params.type,
        reason: params.reason,
        sourceId: params.sourceId,
        zoneId: params.zoneId ? new mongoose.Types.ObjectId(params.zoneId) : undefined,
      },
    ],
    session ? { session } : {}
  );
  return doc;
}
