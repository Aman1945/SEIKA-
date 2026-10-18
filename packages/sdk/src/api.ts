import type {
  AuditRow,
  BookingRow,
  EventStats,
  ExportFormat,
  ExportType,
  LeaderboardPeriod,
  LeaderboardRow,
  LeaderboardScope,
  LedgerRow,
  MigrationUpload,
  NotificationRow,
  OccupancyStats,
  OrderRow,
  OrderStatus,
  OtpRequestResult,
  Overview,
  Passport,
  PathDecision,
  PaymentSource,
  PcMapEntry,
  PcStatus,
  PlayerStats,
  ProductRow,
  SessionMode,
  SessionRow,
  SharedBracket,
  ShopStats,
  StaffRole,
  StaffRow,
  SyncGame,
  TokenPair,
  ValidationReport,
  ZoneConnectionRow,
} from "@seika/types";

import type { SeikaClient } from "./client";

/**
 * One method per endpoint, grouped the way the API is.
 *
 * The point is that a screen never builds a URL or remembers whether an
 * envelope is `{ ok, sessions }` or `{ ok, data }` — the unwrapping lives here,
 * once, next to the type it produces.
 */
export function createApi(client: SeikaClient) {
  const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
    client.request<T>(path, { query });
  const post = <T>(path: string, body?: unknown) =>
    client.request<T>(path, { method: "POST", body });
  const patch = <T>(path: string, body?: unknown) =>
    client.request<T>(path, { method: "PATCH", body });

  return {
    auth: {
      requestOtp: (identifier: string, audience: "player" | "staff" = "player") =>
        client.request<{ ok: true } & OtpRequestResult>("/api/auth/otp/request", {
          method: "POST",
          body: { identifier, audience },
          anonymous: true,
        }),

      verifyOtp: async (
        identifier: string,
        code: string,
        audience: "player" | "staff" = "player"
      ): Promise<TokenPair> => {
        const body = await client.request<{ ok: true } & TokenPair>("/api/auth/otp/verify", {
          method: "POST",
          body: { identifier, code, audience },
          anonymous: true,
        });
        const tokens: TokenPair = {
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
          subjectType: body.subjectType,
        };
        client.setTokens(tokens);
        return tokens;
      },

      me: () =>
        get<{ ok: true; auth: { sub: string; typ: "player" | "staff"; role?: StaffRole; zoneId?: string } }>(
          "/api/auth/me"
        ).then((r) => r.auth),

      logout: async () => {
        // Best effort: revoking server-side is good hygiene, but a network
        // failure must not leave the user stuck in a logged-in shell.
        await post("/api/auth/logout").catch(() => undefined);
        client.logout();
      },
    },

    pcs: {
      map: (zoneId?: string) =>
        get<{ ok: true; pcs: PcMapEntry[] }>("/api/pcs/map", { zoneId }).then((r) => r.pcs),
      list: () => get<{ ok: true; pcs: PcMapEntry[] }>("/api/pcs").then((r) => r.pcs),
      create: (body: { pcNumber: string; branchId: string; hourlyRate: number; category?: string }) =>
        post<{ ok: true; pc: PcMapEntry & { clientKey: string } }>("/api/pcs", body),
      qr: (pcId: string) =>
        post<{ ok: true; pcId: string; token: string; expiresInSeconds: number }>(
          `/api/pcs/${pcId}/qr`
        ),
      command: (
        pcId: string,
        action: "lock" | "unlock" | "restart" | "shutdown" | "maintenance"
      ) => post<{ ok: true; sent: string }>(`/api/pcs/${pcId}/command`, { action }),
    },

    sessions: {
      /** Attach by typing the code on the PC screen, for a player who cannot scan. */
      attachCode: (code: string) =>
        post<{ ok: true; sessionId: string; status: string; note: string }>(
          "/api/sessions/attach-code",
          { code }
        ),
      history: (params: { limit?: number; skip?: number } = {}) =>
        get<{ ok: true; total: number; sessions: SessionRow[] }>("/api/sessions/history/list", params),
      byId: (id: string) => get<{ ok: true; session: SessionRow }>(`/api/sessions/${id}`),

      // Player-side core loop.
      attach: (qrToken: string) =>
        post<{ ok: true; sessionId: string; status: string; note: string }>("/api/sessions/attach", {
          qrToken,
        }),
      authorize: (
        sessionId: string,
        body: {
          source: PaymentSource;
          sessionMode?: SessionMode;
          selectedMinutes?: number;
          voucherCode?: string;
          game?: string;
        }
      ) =>
        post<{
          ok: boolean;
          authorized: boolean;
          reason?: string;
          minStartAmount?: number;
          balance?: number;
          sessionMode?: SessionMode;
        }>(`/api/sessions/${sessionId}/authorize`, body),
      start: (sessionId: string) =>
        post<{ ok: true; sessionId: string; status: string; startTime: string }>(
          `/api/sessions/${sessionId}/start`
        ),
      end: (sessionId: string) =>
        post<{
          ok: true;
          validMinutes: number;
          cost: number;
          xp: { gained: number; leveledUp: boolean; level: number; rank: string; coinsAwarded?: number };
        }>(`/api/sessions/${sessionId}/end`),
      refund: (sessionId: string, reason?: string) =>
        post<{ ok: true; refundedAmount: number; xpReversed: number }>(
          `/api/sessions/${sessionId}/refund`,
          { reason }
        ),
    },

    wallet: {
      balance: (playerId: string) =>
        get<{ ok: true; balance: number }>(`/api/wallet/${playerId}/balance`).then((r) => r.balance),
      ledger: (playerId: string) =>
        get<{ ok: true; ledger: LedgerRow[] }>(`/api/wallet/${playerId}/ledger`).then((r) => r.ledger),
      topup: (body: { playerId: string; amount: number; method?: "CASH" | "GATEWAY" }) =>
        post<{ ok: true; entryId: string; balance: number }>("/api/wallet/topup", body),
    },

    payments: {
      createOrder: (body: { amount: number; zoneId: string }) =>
        post<{ ok: true; orderId: string; amount: number; currency: string; keyId?: string; mock: boolean }>(
          "/api/payments/order",
          body
        ),
      /** Dev only: simulates the gateway callback so a top-up can be tested. */
      simulate: (orderId: string) =>
        post<{ ok: true; credited?: number; alreadyPaid?: boolean }>("/api/payments/dev/simulate", {
          orderId,
        }),
    },

    bookings: {
      mine: () => get<{ ok: true; bookings: BookingRow[] }>("/api/bookings/mine").then((r) => r.bookings),
      create: (body: { pcId: string; slotStart: string; slotEnd: string }) =>
        post<{ ok: true; bookingId: string; amount: number; qrCode: string; paymentStatus: string }>(
          "/api/bookings",
          body
        ),
      pay: (bookingId: string) =>
        post<{ ok: true; paymentStatus: string }>(`/api/bookings/${bookingId}/pay`),
      checkin: (qrCode: string) =>
        post<{ ok: true; bookingId: string; playerId: string; pcId: string }>("/api/bookings/checkin", {
          qrCode,
        }),
      cancel: (bookingId: string) =>
        post<{ ok: true; status: string }>(`/api/bookings/${bookingId}/cancel`),
    },

    shop: {
      products: (zoneId?: string) =>
        get<{ ok: true; products: ProductRow[] }>("/api/shop/products", { zoneId }).then(
          (r) => r.products
        ),
      createProduct: (body: {
        name: string;
        category?: string;
        price: number;
        stockQty?: number;
        lowStockThreshold?: number;
      }) => post<{ ok: true; productId: string }>("/api/shop/products", body),
      updateProduct: (id: string, body: Partial<{ stockQty: number; price: number; active: boolean }>) =>
        patch<{ ok: true; product: ProductRow }>(`/api/shop/products/${id}`, body),
      lowStock: () =>
        get<{ ok: true; products: ProductRow[] }>("/api/shop/low-stock").then((r) => r.products),

      placeOrder: (body: {
        items: { productId: string; qty: number }[];
        paymentSource?: "WALLET" | "CASH" | "SESSION_BILL";
      }) =>
        post<{
          ok: true;
          orderId: string;
          total: number;
          status: OrderStatus;
          zoneId: string;
          pcId: string;
          sessionId: string;
        }>("/api/shop/orders", body),
      queue: () => get<{ ok: true; orders: OrderRow[] }>("/api/shop/orders/queue").then((r) => r.orders),
      setOrderStatus: (orderId: string, status: Exclude<OrderStatus, "received" | "refunded">) =>
        patch<{ ok: true; status: OrderStatus }>(`/api/shop/orders/${orderId}/status`, { status }),
    },

    players: {
      passport: () => get<{ ok: true; passport: Passport }>("/api/players/me/passport").then((r) => r.passport),
      passportOf: (playerId: string) =>
        get<{ ok: true; passport: Passport }>(`/api/players/${playerId}/passport`).then((r) => r.passport),
      updateProfile: (body: {
        name?: string;
        gamerTag?: string;
        avatar?: string;
        city?: string;
        country?: string;
        favoriteGames?: string[];
      }) => patch<{ ok: true; passport: Passport }>("/api/players/me", body).then((r) => r.passport),
    },

    leaderboard: (params: {
      scope?: LeaderboardScope;
      period?: LeaderboardPeriod;
      zoneId?: string;
      region?: string;
      country?: string;
      city?: string;
      game?: string;
      limit?: number;
    }) =>
      client
        .request<{ ok: true; leaderboard: LeaderboardRow[] }>("/api/leaderboard", {
          query: params as Record<string, string | number | undefined>,
          anonymous: true,
        })
        .then((r) => r.leaderboard),

    notifications: {
      list: () =>
        get<{ ok: true; notifications: NotificationRow[]; unread: number }>("/api/notifications"),
      markAllRead: () => post<{ ok: true }>("/api/notifications/read-all"),
    },

    staff: {
      list: () => get<{ ok: true; staff: StaffRow[] }>("/api/staff").then((r) => r.staff),
      create: (body: { name: string; role: StaffRole; phone?: string; email?: string }) =>
        post<{ ok: true; staffId: string }>("/api/staff", body),
    },

    audit: (params: { action?: string; entityType?: string; limit?: number; skip?: number } = {}) =>
      get<{ ok: true; total: number; logs: AuditRow[] }>("/api/audit", params),

    analytics: {
      overview: () => get<{ ok: true; overview: Overview }>("/api/analytics/overview").then((r) => r.overview),
      occupancy: (days = 30) =>
        get<{ ok: true; occupancy: OccupancyStats }>("/api/analytics/occupancy", { days }).then(
          (r) => r.occupancy
        ),
      players: (days = 30) =>
        get<{ ok: true; players: PlayerStats }>("/api/analytics/players", { days }).then((r) => r.players),
      shop: (days = 30) =>
        get<{ ok: true; shop: ShopStats }>("/api/analytics/shop", { days }).then((r) => r.shop),
      events: () => get<{ ok: true; events: EventStats }>("/api/analytics/events").then((r) => r.events),
      exportUrl: (type: ExportType, format: ExportFormat, range?: { since?: string; until?: string }) =>
        ({ type, format, ...range }) as Record<string, string>,
      download: (type: ExportType, format: ExportFormat, range?: { since?: string; until?: string }) =>
        client.download("/api/analytics/export", { type, format, ...range }),
    },

    crossZone: {
      connections: () =>
        get<{ ok: true; connections: ZoneConnectionRow[] }>("/api/crosszone/connections").then(
          (r) => r.connections
        ),
      requestConnection: (toZoneId: string, message?: string) =>
        post<{ ok: true; connectionId: string; status: string }>("/api/crosszone/connections", {
          toZoneId,
          message,
        }),
      respondToConnection: (connectionId: string, accept: boolean) =>
        post<{ ok: true; status: string }>(`/api/crosszone/connections/${connectionId}/respond`, {
          accept,
        }),

      invite: (eventId: string, zoneId: string) =>
        post<{ ok: true }>(`/api/crosszone/events/${eventId}/invite`, { zoneId }),
      respondToInvite: (eventId: string, accept: boolean) =>
        post<{ ok: true }>(`/api/crosszone/events/${eventId}/invite/respond`, { accept }),

      register: (eventId: string, zoneId: string) =>
        post<{ ok: true; registrationId: string; zoneId: string; paymentStatus: string }>(
          `/api/crosszone/events/${eventId}/register`,
          { zoneId }
        ),
      checkin: (eventId: string, playerId: string) =>
        post<{ ok: true; checkedIn: boolean; zoneId: string }>(
          `/api/crosszone/events/${eventId}/checkin`,
          { playerId }
        ),
      bracket: (eventId: string) =>
        get<{ ok: true; bracket: SharedBracket }>(`/api/crosszone/events/${eventId}/bracket`).then(
          (r) => r.bracket
        ),
      submitResults: (eventId: string, placements: { playerId: string; place: number }[]) =>
        post<{
          ok: true;
          verificationStatus: string;
          consensus: { complete: boolean; agreed: boolean; missingZones: string[] };
        }>(`/api/crosszone/events/${eventId}/results`, { placements }),
      verification: (eventId: string) =>
        get<{
          ok: true;
          verificationStatus: string;
          consensus: { complete: boolean; agreed: boolean; missingZones: string[] };
          submissions: { zoneId: string; submittedAt: string }[];
          disputes: {
            id: string;
            zoneId: string;
            reason: string;
            raisedAt: string;
            resolvedAt: string | null;
          }[];
        }>(`/api/crosszone/events/${eventId}/verification`),
      raiseDispute: (eventId: string, reason: string) =>
        post<{ ok: true; verificationStatus: string }>(`/api/crosszone/events/${eventId}/disputes`, {
          reason,
        }),
      resolveDispute: (eventId: string, disputeId: string, resolution: string) =>
        post<{ ok: true; verificationStatus: string }>(
          `/api/crosszone/events/${eventId}/disputes/${disputeId}/resolve`,
          { resolution }
        ),
      settle: (eventId: string) =>
        post<{ ok: true; settlement: { pool: number; prizeTotal: number } }>(
          `/api/crosszone/events/${eventId}/settle`
        ),
      settlement: (eventId: string) =>
        get<{
          ok: true;
          settlement:
            | { settled: false }
            | {
                settled: true;
                pool: number;
                prizeTotal: number;
                yourFees: number;
                yourNet: number;
                netByZone?: Record<string, number>;
              };
        }>(`/api/crosszone/events/${eventId}/settlement`).then((r) => r.settlement),
    },

    tournaments: {
      list: () => get<{ ok: true; tournaments: unknown[] }>("/api/tournaments"),
      create: (body: {
        name: string;
        game?: string;
        entryFee?: number;
        maxPlayers?: number;
        startsAt?: string;
      }) => post<{ ok: true; tournamentId: string }>("/api/tournaments", body),
    },

    smartSync: {
      games: () => get<{ ok: true; games: SyncGame[] }>("/api/smartsync/games").then((r) => r.games),
      screen: (game: string, paths: string[]) =>
        post<{ ok: true; game: string; allowed: string[]; refused: PathDecision[] }>(
          "/api/smartsync/screen",
          { game, paths }
        ),
      download: (game: string) =>
        get<{
          ok: true;
          config: { game: string; version: number; payload: string | null; exists: boolean };
        }>(`/api/smartsync/config/${encodeURIComponent(game)}`).then((r) => r.config),
      upload: (
        game: string,
        body: { payload: string; paths: string[]; baseVersion: number; onConflict?: "abort" | "overwrite" }
      ) =>
        post<{ ok: true; version: number; conflict: boolean }>(
          `/api/smartsync/config/${encodeURIComponent(game)}`,
          body
        ),
    },

    migration: {
      upload: (csv: string, filename?: string) =>
        post<{ ok: true } & MigrationUpload>("/api/migration/uploads", { csv, filename }),
      setMapping: (importId: string, mapping: Record<string, string>) =>
        post<{ ok: true; importId: string; status: string; report: ValidationReport }>(
          `/api/migration/${importId}/mapping`,
          { mapping }
        ),
      commit: (importId: string) =>
        post<{
          ok: true;
          playersCreated: number;
          openingBalanceEntries: number;
          openingBalanceTotal: number;
        }>(`/api/migration/${importId}/commit`),
      list: () => get<{ ok: true; imports: Record<string, unknown>[] }>("/api/migration"),
    },

    zones: {
      settings: (zoneId: string, body: { postpaidEnabled?: boolean }) =>
        patch<{ ok: true }>(`/api/zones/${zoneId}`, body),
      branches: (zoneId: string) =>
        get<{ ok: true; branches: { _id: string; name: string }[] }>(`/api/zones/${zoneId}/branches`),
    },

    health: {
      ready: () =>
        client.request<{ ok: boolean; checks: Record<string, { ok: boolean; detail?: string }> }>(
          "/health/ready",
          { anonymous: true }
        ),
    },
  };
}

export type SeikaApi = ReturnType<typeof createApi>;

/** Kept in sync with the API's PC status colours so both clients agree. */
export const PC_STATUS_TONE: Record<PcStatus, "ok" | "busy" | "warn" | "bad" | "idle"> = {
  AVAILABLE: "ok",
  OCCUPIED: "busy",
  RESERVED: "warn",
  CLEANING: "idle",
  MAINTENANCE: "warn",
  OFFLINE: "bad",
};
