"use client";

import { useState } from "react";

import type { ExportFormat, ExportType } from "@seika/types";

import { useSession } from "@/lib/session";
import { useLiveData, useZoneStream } from "@/lib/realtime";
import { Empty, ErrorNote, Loading, Stat, duration, money } from "@/components/ui";

const EXPORT_TYPES: { value: ExportType; label: string }[] = [
  { value: "sessions", label: "Sessions" },
  { value: "revenue", label: "Wallet ledger" },
  { value: "players", label: "Players" },
  { value: "shop", label: "Shop orders" },
  { value: "bookings", label: "Bookings" },
  { value: "events", label: "Events" },
];

/**
 * Revenue and reports (plan G5, L1–L7).
 *
 * The mobile view is the point: an owner checks today's number from their
 * phone far more often than they sit at a desk with it.
 */
export default function AnalyticsPage() {
  const { api, staff, can } = useSession();
  const stream = useZoneStream(staff?.zoneId);

  const [days, setDays] = useState(30);
  const [exportType, setExportType] = useState<ExportType>("sessions");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const overview = useLiveData(() => api.analytics.overview(), {
    revision: stream.revision,
    fallbackMs: 60_000,
  });
  const occupancy = useLiveData(() => api.analytics.occupancy(days), {
    revision: days,
    fallbackMs: 0,
  });
  const players = useLiveData(() => api.analytics.players(days), { revision: days, fallbackMs: 0 });
  const shop = useLiveData(() => api.analytics.shop(days), { revision: days, fallbackMs: 0 });

  async function download() {
    setDownloading(true);
    setExportError(null);
    try {
      const { blob, filename } = await api.analytics.download(exportType, exportFormat, {
        since: since || undefined,
        until: until || undefined,
      });
      // Anchor-click is the only way to name a downloaded blob in a browser.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <h1>Revenue &amp; reports</h1>
      <p className="page-sub">Today at a glance, then the last {days} days in detail.</p>

      <ErrorNote error={overview.error} />

      {overview.loading && !overview.data ? (
        <Loading rows={3} />
      ) : (
        <div className="grid">
          <Stat label="Revenue today" value={money(overview.data?.revenueToday)} />
          <Stat label="Sessions" value={money(overview.data?.breakdown.sessions)} />
          <Stat label="Shop" value={money(overview.data?.breakdown.shop)} />
          <Stat label="Top-ups" value={money(overview.data?.topupsToday)} />
          <Stat
            label="Seats in use"
            value={`${overview.data?.pcs.occupied ?? 0}/${overview.data?.pcs.total ?? 0}`}
            note={`${overview.data?.occupancyPct ?? 0}% occupancy`}
          />
          <Stat label="Bookings today" value={overview.data?.bookingsToday ?? 0} />
        </div>
      )}

      <div className="row row--wrap" style={{ marginTop: 24, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Trends</h2>
        <div className="spacer" />
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          style={{ width: "auto" }}
          aria-label="Window"
        >
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
      </div>

      <div className="stack" style={{ marginTop: 12 }}>
        <div className="card">
          <div className="card__head">
            <h3 className="card__title">Occupancy</h3>
          </div>
          {occupancy.loading && !occupancy.data ? (
            <Loading rows={2} />
          ) : !occupancy.data ? (
            <Empty>No sessions in this window.</Empty>
          ) : (
            <>
              <div className="grid" style={{ marginBottom: 12 }}>
                <Stat label="Utilisation" value={`${occupancy.data.utilisationPct}%`} />
                <Stat label="Played" value={duration(occupancy.data.playedMinutes)} />
                <Stat label="Empty seat time" value={duration(occupancy.data.idleMinutes)} />
                <Stat
                  label="Peak hour"
                  value={
                    occupancy.data.peakHours[0]
                      ? `${String(occupancy.data.peakHours[0].hour).padStart(2, "0")}:00`
                      : "—"
                  }
                  note={
                    occupancy.data.peakHours[0]
                      ? `${occupancy.data.peakHours[0].sessions} sessions`
                      : undefined
                  }
                />
              </div>

              {/* A bar per hour: enough to see when the zone is busy, without
                  pulling in a charting library for one screen. */}
              <HourBars data={occupancy.data.byHour} />

              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table>
                  <thead>
                    <tr>
                      <th>PC</th>
                      <th className="right">Sessions</th>
                      <th className="right">Played</th>
                      <th className="right">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {occupancy.data.perPc.map((pc) => (
                      <tr key={pc.pcId}>
                        <td>{pc.pcNumber}</td>
                        <td className="right num">{pc.sessions}</td>
                        <td className="right num">{duration(pc.minutes)}</td>
                        <td className="right num">{money(pc.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="card__head">
            <h3 className="card__title">Players</h3>
          </div>
          {players.loading && !players.data ? (
            <Loading rows={2} />
          ) : !players.data ? (
            <Empty>No player activity yet.</Empty>
          ) : (
            <>
              <div className="grid" style={{ marginBottom: 12 }}>
                <Stat label="Active" value={players.data.activeInWindow} />
                <Stat label="New" value={players.data.newPlayers} />
                <Stat
                  label="Returning"
                  value={players.data.returningPlayers}
                  note={`${players.data.retentionPct}% of active`}
                />
                <Stat label="All time" value={players.data.totalPlayers} />
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th className="right">Sessions</th>
                      <th className="right">Played</th>
                      <th className="right">Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {players.data.topPlayers.slice(0, 10).map((p) => (
                      <tr key={p.playerId}>
                        <td>
                          {p.displayName} <span className="faint small">L{p.level}</span>
                        </td>
                        <td className="right num">{p.sessions}</td>
                        <td className="right num">{duration(p.minutes)}</td>
                        <td className="right num">{money(p.spend)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="card__head">
            <h3 className="card__title">Shop</h3>
          </div>
          {shop.loading && !shop.data ? (
            <Loading rows={2} />
          ) : !shop.data ? (
            <Empty>No shop activity yet.</Empty>
          ) : (
            <>
              <div className="grid" style={{ marginBottom: 12 }}>
                <Stat label="Revenue" value={money(shop.data.revenue)} />
                <Stat label="Delivered" value={shop.data.ordersDelivered} />
                <Stat label="Best seller" value={shop.data.bestSellers[0]?.name ?? "—"} />
                <Stat label="Low stock" value={shop.data.lowStock.length} />
              </div>
              {shop.data.lowStock.length > 0 && (
                <div className="alert alert--info" style={{ marginBottom: 0 }}>
                  Running out:{" "}
                  {shop.data.lowStock.map((p) => `${p.name} (${p.stockQty})`).join(", ")}
                </div>
              )}
            </>
          )}
        </div>

        {can("export") && (
          <div className="card">
            <div className="card__head">
              <h3 className="card__title">Export</h3>
            </div>
            <p className="small faint" style={{ marginTop: 0 }}>
              Every download is recorded on the audit log with what was taken.
            </p>

            <ErrorNote error={exportError} />

            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
              <div className="field">
                <label htmlFor="ex-type">Data</label>
                <select
                  id="ex-type"
                  value={exportType}
                  onChange={(e) => setExportType(e.target.value as ExportType)}
                >
                  {EXPORT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ex-format">Format</label>
                <select
                  id="ex-format"
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
                >
                  <option value="csv">CSV</option>
                  <option value="xlsx">Excel</option>
                  <option value="pdf">PDF</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="ex-since">From</label>
                <input id="ex-since" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="ex-until">To</label>
                <input id="ex-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
              </div>
            </div>

            <button className="btn--primary" disabled={downloading} onClick={() => void download()}>
              {downloading ? "Preparing…" : "Download"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** Sessions per hour of day, as a simple CSS bar row. */
function HourBars({ data }: { data: { hour: number; sessions: number }[] }) {
  const byHour = new Map(data.map((d) => [d.hour, d.sessions]));
  const max = Math.max(1, ...data.map((d) => d.sessions));

  return (
    <div
      role="img"
      aria-label={`Sessions by hour. Busiest: ${data.length ? Math.max(...data.map((d) => d.sessions)) : 0} sessions.`}
      style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 72 }}
    >
      {Array.from({ length: 24 }, (_, hour) => {
        const value = byHour.get(hour) ?? 0;
        return (
          <div
            key={hour}
            title={`${String(hour).padStart(2, "0")}:00 — ${value} session${value === 1 ? "" : "s"}`}
            style={{
              flex: 1,
              height: `${Math.max(2, (value / max) * 100)}%`,
              background:
                value > 0 ? "var(--accent)" : "color-mix(in srgb, var(--border) 70%, transparent)",
              borderRadius: 2,
              // Every third hour gets a label; all 24 would be unreadable on a phone.
              position: "relative",
            }}
          />
        );
      })}
    </div>
  );
}
