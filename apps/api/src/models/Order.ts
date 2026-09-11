import { Schema, model, Types } from "mongoose";

export const OrderStatus = [
  "received",
  "preparing",
  "ready",
  "delivered",
  "cancelled",
  "refunded",
] as const;

/** Seat/shop order placed by a player, fulfilled by staff. */
const orderSchema = new Schema(
  {
    playerId: { type: Types.ObjectId, ref: "Player", required: true, index: true },
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    branchId: { type: Types.ObjectId, ref: "Branch" },
    /**
     * Seat binding. Required: every seat order must be traceable to the live
     * session and PC it was placed from (testing plan H4/H5), which is also
     * what makes wrong-zone ordering impossible.
     */
    sessionId: { type: Types.ObjectId, ref: "Session", required: true, index: true },
    pcId: { type: Types.ObjectId, ref: "PC", required: true, index: true },
    items: [
      {
        productId: { type: Types.ObjectId, ref: "Product", required: true },
        name: String,
        qty: { type: Number, required: true },
        price: { type: Schema.Types.Decimal128, required: true },
      },
    ],
    total: { type: Schema.Types.Decimal128, required: true },
    paymentSource: { type: String, enum: ["WALLET", "CASH", "SESSION_BILL"], required: true },
    status: { type: String, enum: OrderStatus, default: "received", index: true },
    staffId: String,
    notes: String,
  },
  { timestamps: true }
);

export const Order = model("Order", orderSchema);
