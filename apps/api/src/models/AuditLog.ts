import { Schema, model } from "mongoose";

/** Append-only audit trail for sensitive actions. */
const auditLogSchema = new Schema(
  {
    actorId: { type: String, required: true },
    actorType: { type: String, enum: ["staff", "player", "system"], default: "staff" },
    zoneId: String,
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: String,
    oldValue: Schema.Types.Mixed,
    newValue: Schema.Types.Mixed,
    reason: String,
    ip: String,
    device: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ zoneId: 1, createdAt: -1 });

export const AuditLog = model("AuditLog", auditLogSchema);
