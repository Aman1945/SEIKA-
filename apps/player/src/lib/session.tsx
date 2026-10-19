"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { SeikaClient, createApi, webTokenStore, type SeikaApi } from "@seika/sdk";
import type { Passport } from "@seika/types";

interface PlayerSession {
  api: SeikaApi;
  playerId: string | null;
  passport: Passport | null;
  loading: boolean;
  requestOtp: (identifier: string) => Promise<{ devCode?: string }>;
  login: (identifier: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-reads the passport — after a top-up, a session, anything that changes it. */
  refresh: () => Promise<void>;
}

const Ctx = createContext<PlayerSession | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [passport, setPassport] = useState<Passport | null>(null);
  const [loading, setLoading] = useState(true);

  const { client, api } = useMemo(() => {
    const c = new SeikaClient({
      baseUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
      // A player stays signed in between visits: they open this app at a
      // counter with one hand, and an OTP every time would be its own reason
      // not to use it.
      tokens: webTokenStore("seika.player.tokens"),
      onAuthExpired: () => {
        setPlayerId(null);
        setPassport(null);
      },
    });
    return { client: c, api: createApi(c) };
  }, []);

  const loadPassport = useCallback(async () => {
    const p = await api.players.passport();
    setPassport(p);
    setPlayerId(p.playerId);
  }, [api]);

  /**
   * Sign in from a handoff token on the URL.
   *
   * The launcher on the PC opens this app with a token the server issued for
   * whoever is seated there, so the player is not asked to sign in a second
   * time on a machine they already paid for. The token is stripped from the
   * address bar immediately: it should not sit in history, and the launcher
   * is not the only thing that can read a URL.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const handoff = url.searchParams.get("handoff");
    if (!handoff) return;

    url.searchParams.delete("handoff");
    window.history.replaceState({}, "", url.pathname + url.search);
    // No refresh token: a handoff lasts the session, and a PC in a gaming
    // zone is not somewhere a long-lived credential should be left behind.
    client.setTokens({ accessToken: handoff, refreshToken: "", subjectType: "player" });
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!client.isAuthenticated) {
        setLoading(false);
        return;
      }
      try {
        const me = await api.auth.me();
        if (cancelled) return;
        if (me.typ !== "player") {
          // A staff token in the player app is not something to work around.
          client.logout();
        } else {
          await loadPassport();
        }
      } catch {
        if (!cancelled) {
          setPlayerId(null);
          setPassport(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, client, loadPassport]);

  const requestOtp = useCallback(
    async (identifier: string) => {
      const res = await api.auth.requestOtp(identifier, "player");
      return { devCode: res.devCode };
    },
    [api]
  );

  const login = useCallback(
    async (identifier: string, code: string) => {
      await api.auth.verifyOtp(identifier, code, "player");
      await loadPassport();
    },
    [api, loadPassport]
  );

  const logout = useCallback(async () => {
    await api.auth.logout();
    setPlayerId(null);
    setPassport(null);
  }, [api]);

  const refresh = useCallback(async () => {
    if (!client.isAuthenticated) return;
    await loadPassport().catch(() => undefined);
  }, [client, loadPassport]);

  const value = useMemo<PlayerSession>(
    () => ({ api, playerId, passport, loading, requestOtp, login, logout, refresh }),
    [api, playerId, passport, loading, requestOtp, login, logout, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayer(): PlayerSession {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePlayer must be used inside <PlayerProvider>");
  return ctx;
}
