/**
 * Shared API types.
 *
 * Hand-written rather than generated, and deliberately describing the *wire*
 * shape the API actually returns — money arrives as a number, ids as strings,
 * dates as ISO strings. Both clients import from here so a field rename breaks
 * the build instead of producing an empty cell in a dashboard.
 */

// ─── Enums (mirrors apps/api/src/models/enums.ts) ────────────────────────────

export const PC_STATUSES = [
  "AVAILABLE",
  "OCCUPIED",
  "RESERVED",
  "OFFLINE",
  "MAINTENANCE",
  "CLEANING",
] as const;
export type PcStatus = (typeof PC_STATUSES)[number];

export const SESSION_STATUSES = [
  "PENDING_AUTH",
  "AUTHORIZED",
  "ACTIVE",
  "PAUSED",
  "LOW_BALANCE",
  "COMPLETED",
  "REFUNDED",
  "CANCELLED",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const PAYMENT_SOURCES = [
  "WALLET",
  "CASH",
  "BOOKING",
  "PACKAGE",
  "VOUCHER",
  "POSTPAID",
] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export type SessionMode = "FIXED_DURATION" | "OPEN_HOUR";

export const STAFF_ROLES = [
  "SUPER_ADMIN",
  "ZONE_OWNER",
  "BRANCH_MANAGER",
  "CASHIER",
  "TECHNICIAN",
  "EVENT_MANAGER",
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ORDER_STATUSES = [
  "received",
  "preparing",
  "ready",
  "delivered",
  "cancelled",
  "refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const WALLET_TXN_TYPES = [
  "TOPUP",
  "DEDUCT",
  "REFUND",
  "ADJUST",
  "PACKAGE",
  "SHOP",
  "BOOKING",
  "OPENING_BALANCE",
] as const;
export type WalletTxnType = (typeof WALLET_TXN_TYPES)[number];

export type LeaderboardScope = "global" | "region" | "country" | "city" | "zone" | "game";
export type LeaderboardPeriod = "weekly" | "monthly" | "all-time";

export type ExportType = "sessions" | "revenue" | "players" | "shop" | "bookings" | "events";
export type ExportFormat = "csv" | "xlsx" | "pdf";

// ─── Auth ────────────────────────────────────────────────────────────────────

export type Audience = "player" | "staff";

export interface AuthClaims {
  sub: string;
  typ: Audience;
  role?: StaffRole;
  zoneId?: string;
}

export interface OtpRequestResult {
  channel: "phone" | "email";
  provider: string;
  expiresInSeconds: number;
  /** Present only outside production, so the dev console can autofill. */
  devCode?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  subjectType: Audience;
}

// ─── Operations ──────────────────────────────────────────────────────────────

export interface PcMapEntry {
  _id: string;
  pcNumber: string;
  status: PcStatus;
  category?: string;
  hourlyRate: number;
  lastHeartbeatAt?: string | null;
  games?: string[];
  branchId?: string;
  /** The live session occupying this PC, if any. */
  activeSession: {
    _id: string;
    playerId: string;
    status: SessionStatus;
    startTime?: string | null;
  } | null;
}

export interface SessionRow {
  _id: string;
  playerId: string;
  pcId: string;
  zoneId: string;
  status: SessionStatus;
  paymentSource?: PaymentSource;
  sessionMode?: SessionMode;
  selectedMinutes?: number | null;
  game?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  validMinutes: number;
  cost: number;
  xpAwarded: number;
  endReason?: string | null;
}

export interface OrderRow {
  _id: string;
  playerId: string;
  zoneId: string;
  pcId?: string;
  sessionId?: string;
  items: { productId: string; name?: string; qty: number; price: number }[];
  total: number;
  paymentSource: "WALLET" | "CASH" | "SESSION_BILL";
  status: OrderStatus;
  createdAt: string;
}

export interface ProductRow {
  _id: string;
  name: string;
  category?: string;
  price: number;
  cost?: number;
  stockQty: number;
  lowStockThreshold: number;
  active: boolean;
}

export interface StaffRow {
  _id: string;
  name: string;
  role: StaffRole;
  phone?: string;
  email?: string;
  zoneId?: string;
}

export interface AuditRow {
  _id: string;
  actorId: string;
  actorType?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  reason?: string;
  oldValue?: unknown;
  newValue?: unknown;
  createdAt: string;
}

// ─── Player-facing ───────────────────────────────────────────────────────────

export interface Passport {
  playerId: string;
  username: string;
  name: string;
  avatar: string | null;
  gamerTag: string | null;
  city: string | null;
  country: string | null;
  region: string | null;
  favoriteGames: string[];
  level: number;
  rank: string;
  nextRank: string;
  xp: {
    total: number;
    currentLevelFloor: number;
    nextLevelAt: number;
    progress: number;
  };
  wallet: { balance: number; currency: string };
  coins: number;
  stats: { bookings: number };
  recentSessions: {
    _id: string;
    pcId: string;
    validMinutes: number;
    cost: number;
    xpAwarded: number;
    status: SessionStatus;
    endTime?: string | null;
  }[];
}

export interface LedgerRow {
  _id: string;
  amount: number;
  type: WalletTxnType;
  method: string;
  reference?: string;
  createdAt: string;
}

export interface BookingRow {
  _id: string;
  playerId: string;
  pcId: string;
  slotStart: string;
  slotEnd: string;
  amount: number;
  paymentStatus: "unpaid" | "paid";
  status: string;
  qrCode: string;
}

export interface NotificationRow {
  _id: string;
  type: string;
  title: string;
  body?: string;
  read: boolean;
  createdAt: string;
}

export interface LeaderboardRow {
  position: number;
  playerId: string;
  username: string;
  level: number;
  rank: string;
  xp: number;
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export interface Overview {
  revenueToday: number;
  breakdown: { sessions: number; shop: number };
  topupsToday: number;
  activeSessions: number;
  pcs: { total: number; occupied: number; available: number; offline: number };
  occupancyPct: number;
  bookingsToday: number;
  ordersPending: number;
}

export interface OccupancyStats {
  windowDays: number;
  peakHours: { hour: number; sessions: number }[];
  byHour: { hour: number; sessions: number; minutes: number }[];
  perPc: { pcId: string; pcNumber: string; sessions: number; minutes: number; revenue: number }[];
  mostUsed: { pcId: string; pcNumber: string; minutes: number } | null;
  leastUsed: { pcId: string; pcNumber: string; minutes: number } | null;
  playedMinutes: number;
  capacityMinutes: number;
  idleMinutes: number;
  utilisationPct: number;
}

export interface PlayerStats {
  windowDays: number;
  totalPlayers: number;
  activeInWindow: number;
  newPlayers: number;
  returningPlayers: number;
  retentionPct: number;
  topPlayers: {
    playerId: string;
    displayName: string;
    level: number;
    sessions: number;
    minutes: number;
    spend: number;
  }[];
}

export interface ShopStats {
  windowDays: number;
  revenue: number;
  ordersDelivered: number;
  bestSellers: { productId: string; name: string; qty: number; revenue: number }[];
  slowMovers: { productId: string; name: string; qty: number; revenue: number }[];
  lowStock: { name: string; stockQty: number }[];
}

export interface EventStats {
  totalEvents: number;
  crossZoneEvents: number;
  completed: number;
  totalRegistrations: number;
  revenueThisZone: number;
  events: {
    tournamentId: string;
    name: string;
    game: string | null;
    status: string;
    crossZone: boolean;
    isHost: boolean;
    registrations: number;
    registrationsFromThisZone: number;
    checkedIn: number;
    revenueThisZone: number;
    pool: number | null;
    netThisZone: number | null;
    verificationStatus: string;
  }[];
}

// ─── Cross-zone ──────────────────────────────────────────────────────────────

export interface ZoneConnectionRow {
  _id: string;
  fromZoneId: string;
  toZoneId: string;
  status: "pending" | "accepted" | "rejected" | "revoked";
  message?: string;
  createdAt: string;
}

export interface SharedBracket {
  tournamentId: string;
  name: string;
  game?: string;
  status: string;
  crossZone: boolean;
  hostZoneId: string;
  entryFee: number;
  maxPlayers: number;
  verificationStatus: "pending" | "verified" | "disputed";
  openDisputes: number;
  zones: {
    zoneId: string;
    zoneName: string;
    isHost: boolean;
    status: string;
    registered: number;
    checkedIn: number;
  }[];
  entrants: {
    playerId: string;
    displayName: string;
    level: number;
    rank: string;
    zoneId: string;
    zoneName: string;
    checkedIn: boolean;
    checkedInZoneId: string | null;
    placement: number | null;
  }[];
}

// ─── Smart Sync ──────────────────────────────────────────────────────────────

export interface SyncGame {
  game: string;
  syncPaths: string[];
  excludePaths: string[];
  notes: string | null;
}

export interface PathDecision {
  path: string;
  allowed: boolean;
  reason?: string;
  antiCheat?: boolean;
}

// ─── Migration ───────────────────────────────────────────────────────────────

export interface MigrationUpload {
  importId: string;
  columns: string[];
  mappableFields: readonly string[];
  suggestedMapping: Record<string, string>;
  rowCount: number;
  sample: Record<string, string>[];
}

export interface ValidationReport {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  issues: { row: number; field?: string; message: string }[];
  preview: Record<string, unknown>[];
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** The single error envelope every endpoint uses. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
