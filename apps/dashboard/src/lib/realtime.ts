"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

/**
 * The zone's live event stream.
 *
 * The screens that matter operationally — the PC map and the order queue — must
 * not depend on a poll interval: a cashier watching an order sit at "received"
 * for ten seconds because that is the refresh rate will stop trusting the
 * screen. Socket.IO pushes; polling is only the fallback when the socket is
 * down.
 */
export type ZoneEvent =
  | "pc:status"
  | "pc:heartbeat"
  | "session:update"
  | "qr:scanned"
  | "order:new"
  | "order:status"
  | "player:levelup"
  | "notification"
  | "announcement"
  | "tournament:results"
  | "crosszone:invite"
  | "crosszone:invite_response"
  | "crosszone:results_submitted"
  | "crosszone:dispute"
  | "crosszone:settled";

const ALL_EVENTS: ZoneEvent[] = [
  "pc:status",
  "pc:heartbeat",
  "session:update",
  "qr:scanned",
  "order:new",
  "order:status",
  "player:levelup",
  "notification",
  "announcement",
  "tournament:results",
  "crosszone:invite",
  "crosszone:invite_response",
  "crosszone:results_submitted",
  "crosszone:dispute",
  "crosszone:settled",
];

export interface ZoneStream {
  connected: boolean;
  /** Bumps on every event, so a screen can simply re-fetch when it changes. */
  revision: number;
  lastEvent: { name: ZoneEvent; payload: unknown; at: number } | null;
}

export function useZoneStream(zoneId: string | undefined): ZoneStream {
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  const [lastEvent, setLastEvent] = useState<ZoneStream["lastEvent"]>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!zoneId) return;

    const socket = io(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000", {
      transports: ["websocket", "polling"],
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    socketRef.current = socket;

    const join = () => {
      socket.emit("join:zone", zoneId);
      setConnected(true);
    };

    socket.on("connect", join);
    // Rejoin after a reconnect: the room membership does not survive the drop,
    // and a silently-empty stream looks exactly like a quiet zone.
    socket.io.on("reconnect", join);
    socket.on("disconnect", () => setConnected(false));

    for (const name of ALL_EVENTS) {
      socket.on(name, (payload: unknown) => {
        setLastEvent({ name, payload, at: Date.now() });
        setRevision((r) => r + 1);
      });
    }

    return () => {
      socket.off();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [zoneId]);

  return { connected, revision, lastEvent };
}

/**
 * Data loader that refreshes on a zone event and, as a backstop, on an
 * interval. The interval is long on purpose: it exists for the case where the
 * socket is down, not as the primary mechanism.
 */
export function useLiveData<T>(
  load: () => Promise<T>,
  deps: {
    revision: number;
    /** Fallback poll in ms. Set 0 to disable. */
    fallbackMs?: number;
    enabled?: boolean;
  }
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [manual, setManual] = useState(0);
  const enabled = deps.enabled ?? true;

  // Keeping the loader in a ref means an inline arrow function from the caller
  // does not restart the effect on every render.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    const run = async () => {
      try {
        const next = await loadRef.current();
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    const fallback = deps.fallbackMs ?? 30_000;
    const timer = fallback > 0 ? setInterval(run, fallback) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [deps.revision, deps.fallbackMs, enabled, manual]);

  return { data, error, loading, reload: () => setManual((m) => m + 1) };
}
