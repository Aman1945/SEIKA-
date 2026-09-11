"use client";

import { useEffect, useState } from "react";

export function money(amount: number | null | undefined): string {
  const v = amount ?? 0;
  return `₹${Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toFixed(2)}`;
}

export function duration(minutes: number | null | undefined): string {
  const m = Math.max(0, Math.round(minutes ?? 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(-6) : "—";
}

/**
 * Elapsed time, derived from the start timestamp on every tick rather than
 * counted up locally — a phone sleeps in a pocket, and a timer that drifts is
 * worse than none when it is what a player is billed by.
 */
export function Elapsed({ since, big = false }: { since: string | null | undefined; big?: boolean }) {
  const [, tick] = useState(0);

  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [since]);

  if (!since) return <span className="faint">—</span>;

  const secs = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;

  return <span className={big ? "playing__time" : "num"}>{text}</span>;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 14}%` }} />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="alert alert--error">{error}</div>;
}
