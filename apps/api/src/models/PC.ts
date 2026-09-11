import { Schema, model, Types } from "mongoose";
import { PCStatus } from "./enums.js";

const pcSchema = new Schema(
  {
    branchId: { type: Types.ObjectId, ref: "Branch", required: true, index: true },
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    pcNumber: { type: String, required: true },
    specs: {
      gpu: String,
      cpu: String,
      ram: String,
      hz: Number,
    },
    games: { type: [String], default: [] },
    category: String, // standard / vip / console
    hourlyRate: { type: Schema.Types.Decimal128, required: true },
    status: { type: String, enum: PCStatus, default: "AVAILABLE", index: true },
    clientKey: { type: String, required: true, unique: true }, // pairing / heartbeat auth
    lastHeartbeatAt: Date,
  },
  { timestamps: true }
);

pcSchema.index({ branchId: 1, pcNumber: 1 }, { unique: true });

export const PC = model("PC", pcSchema);
