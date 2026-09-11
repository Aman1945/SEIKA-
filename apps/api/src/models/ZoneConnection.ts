import { Schema, model, Types } from "mongoose";

export const ConnectionStatus = ["pending", "accepted", "rejected", "revoked"] as const;
export type ConnectionStatus = (typeof ConnectionStatus)[number];

/**
 * An owner-to-owner link between two zones. A connection is the prerequisite
 * for co-hosting a cross-zone event: one owner requests, the other accepts.
 *
 * It grants nothing beyond that — no access to the other zone's customers,
 * wallets, staff or revenue. Only data attached to a shared event is ever
 * visible across the link (plan §8).
 */
const zoneConnectionSchema = new Schema(
  {
    fromZoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    toZoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    /**
     * The unordered pair, "smaller:larger" by id. Uniqueness is on this, so
     * A→B and B→A cannot both exist as separate live connections.
     */
    pairKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ConnectionStatus, default: "pending", index: true },
    requestedBy: { type: String, required: true },
    message: String,
    respondedBy: String,
    respondedAt: Date,
  },
  { timestamps: true }
);

/** Stable key for an unordered zone pair. */
export function pairKeyFor(a: string, b: string): string {
  return [String(a), String(b)].sort().join(":");
}

export const ZoneConnection = model("ZoneConnection", zoneConnectionSchema);
