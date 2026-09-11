import { Schema, model, Types } from "mongoose";

/** Zone announcement / update shown to players. */
const announcementSchema = new Schema(
  {
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    title: { type: String, required: true },
    body: String,
    pinned: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    createdBy: String,
  },
  { timestamps: true }
);

announcementSchema.index({ zoneId: 1, active: 1, createdAt: -1 });

export const Announcement = model("Announcement", announcementSchema);
