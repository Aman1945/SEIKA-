"use client";

import { useState } from "react";

import type { ZoneConnectionRow } from "@seika/types";

import { useSession } from "@/lib/session";
import { useLiveData, useZoneStream } from "@/lib/realtime";
import { Empty, ErrorNote, Loading, money, shortId } from "@/components/ui";

/**
 * Events, including cross-zone (plan module J).
 *
 * Two things here are unlike the rest of the console: a connection is a
 * business relationship with another owner, and a co-hosted event's results
 * need every participating zone to agree before anyone's money moves. Both are
 * shown as explicit state rather than buried in a status field.
 */
export default function EventsPage() {
  const { api, staff, can } = useSession();
  const stream = useZoneStream(staff?.zoneId);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteZoneId, setInviteZoneId] = useState("");
  const [form, setForm] = useState({ name: "", game: "", entryFee: "100", maxPlayers: "16" });

  const events = useLiveData(() => api.analytics.events(), {
    revision: stream.revision,
    fallbackMs: 60_000,
  });
  const connections = useLiveData(() => api.crossZone.connections(), {
    revision: stream.revision,
    enabled: can("crosszone:connect"),
    fallbackMs: 0,
  });

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
      events.reload();
      connections.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const myZone = staff?.zoneId;

  return (
    <>
      <h1>Events</h1>
      <p className="page-sub">
        {events.data?.totalEvents ?? 0} events · {events.data?.crossZoneEvents ?? 0} co-hosted with
        another zone
      </p>

      <ErrorNote error={events.error} />
      <ErrorNote error={error} />
      {notice && <div className="alert alert--ok">{notice}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card__head">
          <h2 className="card__title">Create an event</h2>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run("Event created.", () =>
              api.tournaments.create({
                name: form.name.trim(),
                game: form.game.trim() || undefined,
                entryFee: Number(form.entryFee || 0),
                maxPlayers: Number(form.maxPlayers || 16),
                startsAt: new Date(Date.now() + 86_400_000).toISOString(),
              })
            );
          }}
        >
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field">
              <label htmlFor="e-name">Name</label>
              <input
                id="e-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Friday Valorant Cup"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="e-game">Game</label>
              <input
                id="e-game"
                value={form.game}
                onChange={(e) => setForm({ ...form, game: e.target.value })}
                placeholder="Valorant"
              />
            </div>
            <div className="field">
              <label htmlFor="e-fee">Entry fee (₹)</label>
              <input
                id="e-fee"
                type="number"
                min="0"
                value={form.entryFee}
                onChange={(e) => setForm({ ...form, entryFee: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="e-max">Max players</label>
              <input
                id="e-max"
                type="number"
                min="2"
                value={form.maxPlayers}
                onChange={(e) => setForm({ ...form, maxPlayers: e.target.value })}
              />
            </div>
          </div>
          <button className="btn--primary" disabled={busy || !form.name.trim()}>
            Create
          </button>
        </form>
      </div>

      {can("crosszone:connect") && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card__head">
            <h2 className="card__title">Connected zones</h2>
          </div>
          <p className="small faint" style={{ marginTop: 0 }}>
            A connection only lets you co-host events together. It gives the other owner no access to
            your customers, wallets, staff or revenue.
          </p>

          <div className="row row--wrap" style={{ marginBottom: 12 }}>
            <input
              value={inviteZoneId}
              onChange={(e) => setInviteZoneId(e.target.value)}
              placeholder="Their zone ID"
              style={{ flex: 1, minWidth: 200 }}
            />
            <button
              disabled={busy || !inviteZoneId.trim()}
              onClick={() =>
                void run("Connection request sent.", async () => {
                  await api.crossZone.requestConnection(inviteZoneId.trim());
                  setInviteZoneId("");
                })
              }
            >
              Request
            </button>
          </div>

          {connections.loading && !connections.data ? (
            <Loading rows={2} />
          ) : (connections.data ?? []).length === 0 ? (
            <Empty>No connections yet.</Empty>
          ) : (
            <div className="stack">
              {(connections.data ?? []).map((c: ZoneConnectionRow) => {
                const incoming = c.toZoneId === myZone;
                return (
                  <div key={c._id} className="row row--wrap" style={{ gap: 10 }}>
                    <span className="badge" data-tone={toneForConnection(c.status)}>
                      {c.status}
                    </span>
                    <span className="small mono" title={incoming ? c.fromZoneId : c.toZoneId}>
                      {incoming ? "from" : "to"} {shortId(incoming ? c.fromZoneId : c.toZoneId)}
                    </span>
                    {c.message && <span className="small faint">“{c.message}”</span>}
                    {/* Only the invited side can answer — the API refuses the
                        requester's own approval, so the button is not offered. */}
                    {c.status === "pending" && incoming && (
                      <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
                        <button
                          className="btn--sm btn--primary"
                          disabled={busy}
                          onClick={() =>
                            void run("Connection accepted.", () =>
                              api.crossZone.respondToConnection(c._id, true)
                            )
                          }
                        >
                          Accept
                        </button>
                        <button
                          className="btn--sm"
                          disabled={busy}
                          onClick={() =>
                            void run("Connection declined.", () =>
                              api.crossZone.respondToConnection(c._id, false)
                            )
                          }
                        >
                          Decline
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="card card--flush">
        {events.loading && !events.data ? (
          <div style={{ padding: 14 }}>
            <Loading rows={3} />
          </div>
        ) : (events.data?.events.length ?? 0) === 0 ? (
          <Empty>No events yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Status</th>
                  <th className="right">Players</th>
                  <th className="right">Revenue here</th>
                  <th>Results</th>
                </tr>
              </thead>
              <tbody>
                {events.data!.events.map((e) => (
                  <tr key={e.tournamentId}>
                    <td>
                      {e.name}
                      <div className="small faint">
                        {e.game ?? "—"}
                        {e.crossZone && (
                          <span className="badge" data-tone="busy" style={{ marginLeft: 6 }}>
                            cross-zone {e.isHost ? "host" : "co-host"}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="small">{e.status}</td>
                    <td className="right num">
                      {e.checkedIn}/{e.registrations}
                      {e.crossZone && (
                        <div className="small faint">{e.registrationsFromThisZone} from here</div>
                      )}
                    </td>
                    <td className="right num">
                      {money(e.revenueThisZone)}
                      {e.netThisZone !== null && (
                        <div className="small faint">net {money(e.netThisZone)}</div>
                      )}
                    </td>
                    <td>
                      <span className="badge" data-tone={toneForVerification(e.verificationStatus)}>
                        {e.verificationStatus}
                      </span>
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

function toneForConnection(status: string): string {
  return status === "accepted" ? "ok" : status === "pending" ? "warn" : "idle";
}

function toneForVerification(status: string): string {
  return status === "verified" ? "ok" : status === "disputed" ? "bad" : "warn";
}
