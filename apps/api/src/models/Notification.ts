import { Schema, model, Types } from "mongoose";

const notificationSchema = new Schema(
  {
    playerId: { type: Types.ObjectId, ref: "Player", required: true, index: true },
    type: { type: String, required: true }, // LEVELUP / ORDER / BOOKING / REWARD / SESSION
    title: { type: String, required: true },
    body: String,
    read: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationSchema.index({ playerId: 1, read: 1, createdAt: -1 });

export const Notification = model("Notification", notificationSchema);
