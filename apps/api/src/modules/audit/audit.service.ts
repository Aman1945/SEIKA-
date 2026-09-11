import { AuditLog } from "../../models/AuditLog.js";

export interface AuditEntry {
  actorId: string;
  actorType?: "staff" | "player" | "system";
  zoneId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string;
  ip?: string;
  device?: string;
}

/** Records a sensitive action. Never throws into the request path. */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await AuditLog.create(entry);
  } catch {
    /* audit must not break the request; log pipeline handles failures in P6 */
  }
}
