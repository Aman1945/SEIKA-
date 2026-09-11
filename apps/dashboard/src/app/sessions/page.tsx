"use client";

import { useState } from "react";

import type { SessionRow } from "@seika/types";

import { useSession } from "@/lib/session";
import { useLiveData, useZoneStream } from "@/lib/realtime";
import {
  Elapsed,
  Empty,
  ErrorNote,
  Loading,
  StatusBadge,
  dateTime,
  duration,
  money,
  shortId,
  useConfirm,
} from "@/components/ui";

/**
 * Sessions (plan G3): what is running now, and what ran earlier.
 *
 * Refunds live here because this is where a cashier is standing when a player
 * says "the PC crashed". A refund reverses the wallet, the XP and the coins
 * together, which is worth stating before they press it.
 */
const LIVE_STATUSES = ["PENDING_AUTH", "AUTHORIZED", "ACTIVE", "PAUSED", "LOW_BALANCE"];

export default function SessionsPage() {
  const { api, staff, can } = useSession();
  const stream = useZoneStream(staff?.zoneId);
  const confirm = useConfirm();

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const history = useLiveData(() => api.sessions.history({ limit: showAll ? 100 : 40 }), {
    revision: stream.revision,
    fallbackMs: 30_000,
  });

  const rows = history.data?.sessions ?? [];
  const live = rows.filter((s) => LIVE_STATUSES.includes(s.status));
  const past = rows.filter((s) => !LIVE_STATUSES.includes(s.status));

  async function refund(session: SessionRow) {
    const reason = window.prompt(
      `Refund ${money(session.cost)} for session ${shortId(session._id)}?\n\n` +
        "This credits the wallet back and reverses the XP and coins it earned.\n" +
        "Reason (recorded on the audit log):"
    );
    // An empty reason is still a reason someone can be asked about later; a
    // cancelled prompt is not.
    if (reason === null) return;
    if (!reason.trim() && !confirm("Refund with no reason recorded?")) return;

    setBusyId(session._id);
    setError(null);
    setNotice(null);
    try {
      const res = await api.sessions.refund(session._id, reason.trim() || undefined);
      setNotice(
        `Refunded ${money(res.refundedAmount)} and reversed ${res.xpReversed} XP for ${shortId(session._id)}.`
      );
      history.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <h1>Sessions</h1>
      <p className="page-sub">
        {live.length} live · {history.data?.total ?? 0} total in this zone
      </p>

      <ErrorNote error={history.error} />
      <ErrorNote error={error} />
      {notice && <div className="alert alert--ok">{notice}</div>}

      {history.loading && !history.data ? (
        <Loading rows={4} />
      ) : (
        <>
          <div className="card card--flush">
            <div style={{ padding: "12px 14px 0" }}>
              <h2 className="card__title" style={{ margin: 0 }}>
                Live now
              </h2>
            </div>
            {live.length === 0 ? (
              <Empty>Nobody is playing right now.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Status</th>
                      <th>Mode</th>
                      <th>Paid by</th>
                      <th>Elapsed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {live.map((s) => (
                      <tr key={s._id}>
                        <td className="mono" title={s.playerId}>
                          {shortId(s.playerId)}
                        </td>
                        <td>
                          <StatusBadge status={s.status} />
                        </td>
                        <td className="small">
                          {s.sessionMode === "FIXED_DURATION"
                            ? `${(s.selectedMinutes ?? 0) / 60}h block`
                            : "open hour"}
                          {s.game && <span className="faint"> · {s.game}</span>}
                        </td>
                        <td className="small">{s.paymentSource?.toLowerCase() ?? "—"}</td>
                        <td>
                          {s.startTime ? (
                            <Elapsed since={s.startTime} />
                          ) : (
                            <span className="faint small">locked</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <h2>Earlier</h2>
          <div className="card card--flush">
            {past.length === 0 ? (
              <Empty>No completed sessions yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ended</th>
                      <th>Player</th>
                      <th>Status</th>
                      <th className="right">Played</th>
                      <th className="right">Cost</th>
                      <th className="right">XP</th>
                      {can("wallet:refund") && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {past.map((s) => (
                      <tr key={s._id}>
                        <td className="small">{dateTime(s.endTime)}</td>
                        <td className="mono" title={s.playerId}>
                          {shortId(s.playerId)}
                        </td>
                        <td>
                          <StatusBadge status={s.status} />
                        </td>
                        <td className="right num">{duration(s.validMinutes)}</td>
                        <td className="right num">{money(s.cost)}</td>
                        <td className="right num">{s.xpAwarded}</td>
                        {can("wallet:refund") && (
                          <td className="right">
                            {s.status === "COMPLETED" && s.cost > 0 ? (
                              <button
                                className="btn--sm btn--danger"
                                disabled={busyId === s._id}
                                onClick={() => void refund(s)}
                              >
                                Refund
                              </button>
                            ) : (
                              <span className="faint small">
                                {s.status === "REFUNDED" ? "refunded" : ""}
                              </span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {!showAll && (history.data?.total ?? 0) > rows.length && (
            <button style={{ marginTop: 12 }} onClick={() => setShowAll(true)}>
              Load more
            </button>
          )}
        </>
      )}
    </>
  );
}
