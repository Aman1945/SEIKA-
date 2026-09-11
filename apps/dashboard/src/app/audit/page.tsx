"use client";

import { useState } from "react";

import { useSession } from "@/lib/session";
import { useLiveData, useZoneStream } from "@/lib/realtime";
import { Empty, ErrorNote, Loading, dateTime, shortId } from "@/components/ui";

/**
 * The audit trail.
 *
 * Every sensitive action lands here with who did it and when. It is the screen
 * an owner opens when a number looks wrong, so it is filterable by action
 * rather than being a wall of rows.
 */
const QUICK_FILTERS = [
  { label: "Everything", value: "" },
  { label: "Money", value: "WALLET_TOPUP" },
  { label: "Refunds", value: "SESSION_REFUND" },
  { label: "Exports", value: "DATA_EXPORT" },
  { label: "PC commands", value: "PC_COMMAND_UNLOCK" },
];

export default function AuditPage() {
  const { api, staff } = useSession();
  const stream = useZoneStream(staff?.zoneId);
  const [action, setAction] = useState("");

  const audit = useLiveData(() => api.audit({ action: action || undefined, limit: 100 }), {
    revision: stream.revision + action.length,
    fallbackMs: 60_000,
  });

  const rows = audit.data?.logs ?? [];

  return (
    <>
      <h1>Audit log</h1>
      <p className="page-sub">{audit.data?.total ?? 0} recorded actions in this zone.</p>

      <ErrorNote error={audit.error} />

      <div className="btn-row" style={{ marginBottom: 12 }}>
        {QUICK_FILTERS.map((f) => (
          <button
            key={f.value}
            className="btn--sm"
            style={action === f.value ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
            onClick={() => setAction(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="card card--flush">
        {audit.loading && !audit.data ? (
          <div style={{ padding: 14 }}>
            <Loading rows={4} />
          </div>
        ) : rows.length === 0 ? (
          <Empty>Nothing recorded for this filter.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>By</th>
                  <th>On</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((log) => (
                  <tr key={log._id}>
                    <td className="small" style={{ whiteSpace: "nowrap" }}>
                      {dateTime(log.createdAt)}
                    </td>
                    <td>
                      <span className="badge" data-tone={toneFor(log.action)}>
                        {log.action.replace(/_/g, " ").toLowerCase()}
                      </span>
                    </td>
                    <td className="mono small" title={log.actorId}>
                      {shortId(log.actorId)}
                      {log.actorType && <span className="faint"> ({log.actorType})</span>}
                    </td>
                    <td className="small faint">
                      {log.entityType ?? "—"}
                      {log.entityId && <span className="mono"> {shortId(log.entityId)}</span>}
                    </td>
                    <td className="small faint">
                      {log.reason ?? summarise(log.newValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function toneFor(action: string): string {
  if (/REFUND|DELETE|CANCEL|BLOCKED|DISPUTE/.test(action)) return "warn";
  if (/UNLOCK|SETTLE|EXPORT|MIGRATION/.test(action)) return "busy";
  if (/TOPUP|CREATE|ACCEPT/.test(action)) return "ok";
  return "idle";
}

/** One readable line from an arbitrary audit payload. */
function summarise(value: unknown): string {
  if (!value || typeof value !== "object") return "—";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v}`);
  return entries.length ? entries.join(" · ") : "—";
}
