"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { SeikaClient, createApi, webTokenStore, type SeikaApi } from "@seika/sdk";
import type { StaffRole } from "@seika/types";

interface StaffIdentity {
  sub: string;
  role: StaffRole;
  zoneId?: string;
}

interface SessionValue {
  api: SeikaApi;
  staff: StaffIdentity | null;
  /** Undefined while the stored token is being checked on first paint. */
  loading: boolean;
  login: (identifier: string, code: string) => Promise<void>;
  requestOtp: (identifier: string) => Promise<{ devCode?: string }>;
  logout: () => Promise<void>;
  /** True when this role may do `capability` — mirrors the API's own guards. */
  can: (capability: Capability) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Capabilities the UI hides things by.
 *
 * This is presentation only: the API enforces every one of these itself, and a
 * hidden button is not a permission. Hiding it just stops staff being offered
 * actions that will 403 — the plan's M1 case ("403 or hidden UI").
 */
export type Capability =
  | "analytics"
  | "export"
  | "staff:manage"
  | "products:manage"
  | "orders:manage"
  | "wallet:topup"
  | "wallet:refund"
  | "pc:command"
  | "pc:manage"
  | "audit:view"
  | "events:manage"
  | "crosszone:connect"
  | "migration"
  | "zone:settings";

const ROLE_CAPABILITIES: Record<StaffRole, Capability[]> = {
  SUPER_ADMIN: [
    "analytics", "export", "staff:manage", "products:manage", "orders:manage",
    "wallet:topup", "wallet:refund", "pc:command", "pc:manage", "audit:view",
    "events:manage", "crosszone:connect", "migration", "zone:settings",
  ],
  ZONE_OWNER: [
    "analytics", "export", "staff:manage", "products:manage", "orders:manage",
    "wallet:topup", "wallet:refund", "pc:command", "pc:manage", "audit:view",
    "events:manage", "crosszone:connect", "migration", "zone:settings",
  ],
  BRANCH_MANAGER: [
    "analytics", "export", "products:manage", "orders:manage", "wallet:topup",
    "wallet:refund", "pc:command", "pc:manage", "audit:view", "events:manage",
  ],
  CASHIER: ["orders:manage", "wallet:topup", "wallet:refund"],
  TECHNICIAN: ["pc:command"],
  EVENT_MANAGER: ["events:manage"],
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [staff, setStaff] = useState<StaffIdentity | null>(null);
  const [loading, setLoading] = useState(true);

  // One client for the app's lifetime, so the token store and the
  // single-refresh guard are shared by every screen.
  const { client, api } = useMemo(() => {
    const c = new SeikaClient({
      baseUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
      tokens: webTokenStore("seika.staff.tokens"),
      onAuthExpired: () => setStaff(null),
    });
    return { client: c, api: createApi(c) };
  }, []);

  // A stored token may be expired or revoked, so it is verified against the
  // API before the shell renders as logged in.
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
        if (me.typ !== "staff" || !me.role) {
          // A player token in the staff app is not an error to paper over.
          client.logout();
          setStaff(null);
        } else {
          setStaff({ sub: me.sub, role: me.role, zoneId: me.zoneId });
        }
      } catch {
        if (!cancelled) setStaff(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, client]);

  const requestOtp = useCallback(
    async (identifier: string) => {
      const res = await api.auth.requestOtp(identifier, "staff");
      return { devCode: res.devCode };
    },
    [api]
  );

  const login = useCallback(
    async (identifier: string, code: string) => {
      await api.auth.verifyOtp(identifier, code, "staff");
      const me = await api.auth.me();
      if (me.typ !== "staff" || !me.role) {
        client.logout();
        throw new Error("That account is not a staff account.");
      }
      setStaff({ sub: me.sub, role: me.role, zoneId: me.zoneId });
    },
    [api, client]
  );

  const logout = useCallback(async () => {
    await api.auth.logout();
    setStaff(null);
  }, [api]);

  const can = useCallback(
    (capability: Capability) => (staff ? ROLE_CAPABILITIES[staff.role].includes(capability) : false),
    [staff]
  );

  const value = useMemo<SessionValue>(
    () => ({ api, staff, loading, login, requestOtp, logout, can }),
    [api, staff, loading, login, requestOtp, logout, can]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}
