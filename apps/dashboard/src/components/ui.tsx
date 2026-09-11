"use client";

import { useEffect, useState } from "react";

import type { PcStatus, SessionStatus } from "@seika/types";
import { PC_STATUS_TONE } from "@seika/sdk";

/** ₹ with no decimals unless they matter — a counter reads totals at a glance. */
export function money(amount: number | null | undefined): string {
  const v = amount ?? 0;
  return `₹${Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toFixed(2)}`;
}

/** "1h 25m" rather than "85 minutes": a shift is read in hours. */
export function duration(minutes: number | null | undefined): string {
  const m = Math.max(0, Math.round(minutes ?? 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

export function timeOfDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
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

/** Shortens an ObjectId for display. Full value stays in the title attribute. */
export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.slice(-6);
}

export function StatusBadge({ status }: { status: PcStatus | SessionStatus | string }) {
  const tone =
    (PC_STATUS_TONE as Record<string, string>)[status] ?? SESSION_TONE[status] ?? "idle";
  return (
    <span className="badge" data-tone={tone}>
      <span className="dot" />
      {String(status).replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

const SESSION_TONE: Record<string, string> = {
  PENDING_AUTH: "warn",
  AUTHORIZED: "busy",
  ACTIVE: "busy",
  PAUSED: "idle",
  LOW_BALANCE: "warn",
  COMPLETED: "ok",
  REFUNDED: "idle",
  CANCELLED: "idle",
  received: "warn",
  preparing: "busy",
  ready: "ok",
  delivered: "idle",
  cancelled: "idle",
  refunded: "idle",
  pending: "warn",
  verified: "ok",
  disputed: "bad",
  accepted: "ok",
  rejected: "bad",
  declined: "idle",
  invited: "warn",
};

export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note?: string;
}) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {note && <div className="stat__note">{note}</div>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="alert alert--error">{error}</div>;
}

/**
 * A live-ticking elapsed clock for an active session.
 *
 * Derived from the start timestamp rather than counted up locally, so it stays
 * right after a tab sleeps — a timer that drifts is worse than none when it is
 * what a cashier bills from.
 */
export function Elapsed({ since }: { since: string | null | undefined }) {
  const [, force] = useState(0);

  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [since]);

  if (!since) return <span className="faint">—</span>;

  const seconds = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <span className="num">
      {h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`}
    </span>
  );
}

/** Confirmation for anything that moves money or a PC's state. */
export function useConfirm() {
  return (message: string) => {
    if (typeof window === "undefined") return false;
    return window.confirm(message);
  };
}
