import { Schema, model, Types } from "mongoose";

/** Maps a payment-gateway order to the player/amount to credit on success. */
const paymentOrderSchema = new Schema(
  {
    orderId: { type: String, required: true, unique: true }, // razorpay order id (or mock)
    playerId: { type: Types.ObjectId, ref: "Player", required: true, index: true },
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    currency: { type: String, default: "INR" },
    provider: { type: String, default: "razorpay" },
    status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
    paymentId: String, // razorpay payment id once captured
  },
  { timestamps: true }
);

export const PaymentOrder = model("PaymentOrder", paymentOrderSchema);
