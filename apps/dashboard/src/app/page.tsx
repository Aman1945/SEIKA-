"use client";

import { useState } from "react";

import { PC_STATUS_TONE } from "@seika/sdk";
import type { PcMapEntry } from "@seika/types";

import { useSession } from "@/lib/session";
import { useLiveData, useZoneStream } from "@/lib/realtime";
import {
  Elapsed,
  Empty,
  ErrorNote,
  Loading,
  Stat,
  StatusBadge,
  money,
  shortId,
  useConfirm,
} from "@/components/ui";

/**
 * The live screen (plan G2, G3, G6): the PC map, what each PC is doing right
 * now, and the commands staff can send it.
 *
 * Everything here is pushed over the zone's socket. The PC map is the screen an
 * owner leaves open, so it must be right without a refresh.
 */
export default function LivePage() {
  const { api, staff, can } = useSession();
  const stream = useZoneStream(staff?.zoneId);
  const confirm = useConfirm();

  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const pcs = useLiveData(() => api.pcs.map(), { revision: stream.revision });
  const overview = useLiveData(() => api.analytics.overview(), {
    revision: stream.revision,
    enabled: can("analytics"),
    fallbackMs: 60_000,
  });

  const list = pcs.data ?? [];
  const chosen = list.find((pc) => pc._id === selected) ?? null;

  async function sendCommand(
    pc: PcMapEntry,
    action: "lock" | "unlock" | "restart" | "maintenance"
  ) {
    // Unlocking by hand bypasses the authorization engine, and restarting drops
    // whoever is mid-game. Both deserve a pause.
    const risky = action === "unlock" || action === "restart";
    if (risky && !confirm(`${action} ${pc.pcNumber}? ${describeRisk(action, pc)}`)) return;

    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await api.pcs.command(pc._id, action);
      setNotice(`Sent ${action} to ${pc.pcNumber}. It is on the audit log.`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const occupied = list.filter((pc) => pc.activeSession).length;
  const offline = list.filter((pc) => pc.status === "OFFLINE").length;

  return (
    <>
      <h1>Live</h1>
      <p className="page-sub">
        {list.length} PCs · {occupied} in use
        {offline > 0 && <> · {offline} offline</>}
      </p>

      {can("analytics") && (
        <div className="grid" style={{ marginBottom: 20 }}>
          <Stat
            label="Revenue today"
            value={money(overview.data?.revenueToday)}
            note={
              overview.data
                ? `sessions ${money(overview.data.breakdown.sessions)} · shop ${money(overview.data.breakdown.shop)}`
                : undefined
            }
          />
          <Stat label="Top-ups today" value={money(overview.data?.topupsToday)} />
          <Stat
            label="Occupancy"
            value={`${overview.data?.occupancyPct ?? 0}%`}
            note={overview.data ? `${overview.data.pcs.occupied}/${overview.data.pcs.total} seats` : undefined}
          />
          <Stat
            label="Orders waiting"
            value={overview.data?.ordersPending ?? 0}
            note={overview.data?.bookingsToday ? `${overview.data.bookingsToday} bookings today` : undefined}
          />
        </div>
      )}

      <ErrorNote error={pcs.error} />
      <ErrorNote error={actionError} />
      {notice && <div className="alert alert--ok">{notice}</div>}

      {pcs.loading && !pcs.data ? (
        <Loading rows={4} />
      ) : list.length === 0 ? (
        <Empty>
          No PCs in this zone yet. Add one from the zone settings, and its kiosk will appear here
          once it sends a heartbeat.
        </Empty>
      ) : (
        <div className="pc-grid">
          {list.map((pc) => {
            const session = pc.activeSession;
            const tone = session ? "busy" : PC_STATUS_TONE[pc.status];
            return (
              <button
                key={pc._id}
                className="pc"
                data-tone={tone}
                data-selected={selected === pc._id}
                onClick={() => setSelected(selected === pc._id ? null : pc._id)}
                aria-expanded={selected === pc._id}
              >
                <span className="pc__number">{pc.pcNumber}</span>
                <span className="pc__meta">
                  {session ? session.status.replace(/_/g, " ").toLowerCase() : pc.status.toLowerCase()}
                </span>
                <span className="pc__meta">{money(pc.hourlyRate)}/hr</span>
                <span className="pc__timer">
                  {session?.startTime ? (
                    <Elapsed since={session.startTime} />
                  ) : session ? (
                    <span className="faint">awaiting payment</span>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {chosen && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card__head">
            <h2 className="card__title" style={{ margin: 0 }}>
              {chosen.pcNumber}
            </h2>
            <div className="card__actions">
              <StatusBadge status={chosen.status} />
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <tbody>
                <tr>
                  <th>Rate</th>
                  <td>{money(chosen.hourlyRate)} / hour</td>
                </tr>
                <tr>
                  <th>Heartbeat</th>
                  <td>
                    {chosen.lastHeartbeatAt ? (
                      <Elapsed since={chosen.lastHeartbeatAt} />
                    ) : (
                      <span className="faint">never — the kiosk has not checked in</span>
                    )}
                    {chosen.lastHeartbeatAt && <span className="faint"> ago</span>}
                  </td>
                </tr>
                {chosen.activeSession ? (
                  <>
                    <tr>
                      <th>Session</th>
                      <td>
                        <StatusBadge status={chosen.activeSession.status} />
                      </td>
                    </tr>
                    <tr>
                      <th>Player</th>
                      <td className="mono" title={chosen.activeSession.playerId}>
                        {shortId(chosen.activeSession.playerId)}
                      </td>
                    </tr>
                    <tr>
                      <th>Playing for</th>
                      <td>
                        {chosen.activeSession.startTime ? (
                          <Elapsed since={chosen.activeSession.startTime} />
                        ) : (
                          <span className="faint">not started — PC is still locked</span>
                        )}
                      </td>
                    </tr>
                  </>
                ) : (
                  <tr>
                    <th>Session</th>
                    <td className="faint">idle</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {can("pc:command") ? (
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn--sm" disabled={busy} onClick={() => void sendCommand(chosen, "lock")}>
                Lock
              </button>
              <button className="btn--sm" disabled={busy} onClick={() => void sendCommand(chosen, "unlock")}>
                Unlock
              </button>
              <button className="btn--sm" disabled={busy} onClick={() => void sendCommand(chosen, "restart")}>
                Restart
              </button>
              <button
                className="btn--sm"
                disabled={busy}
                onClick={() => void sendCommand(chosen, "maintenance")}
              >
                Maintenance
              </button>
            </div>
          ) : (
            <p className="small faint" style={{ marginBottom: 0 }}>
              Your role cannot send PC commands.
            </p>
          )}
        </div>
      )}
    </>
  );
}

function describeRisk(action: string, pc: PcMapEntry): string {
  if (action === "unlock") {
    return pc.activeSession
      ? "This bypasses payment authorization for a session that is not authorized."
      : "This unlocks a PC with no paid session — the player plays for free.";
  }
  if (action === "restart" && pc.activeSession) {
    return "Someone is playing on it right now.";
  }
  return "";
}
