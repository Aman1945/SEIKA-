export const PCStatus = [
  "AVAILABLE",
  "OCCUPIED",
  "RESERVED",
  "OFFLINE",
  "MAINTENANCE",
  "CLEANING",
  "TOURNAMENT_LOCKED",
] as const;
export type PCStatus = (typeof PCStatus)[number];

export const SessionStatus = [
  "PENDING_AUTH",
  "AUTHORIZED",
  "ACTIVE",
  "PAUSED",
  "LOW_BALANCE",
  "ENDING",
  "COMPLETED",
  "CANCELLED",
  "REFUNDED",
] as const;
export type SessionStatus = (typeof SessionStatus)[number];

export const PaymentSource = [
  "WALLET",
  "BOOKING",
  "CASH",
  "PACKAGE",
  "VOUCHER",
  "POSTPAID",
] as const;
export type PaymentSource = (typeof PaymentSource)[number];

export const WalletTxnType = [
  "TOPUP",
  "DEDUCT",
  "REFUND",
  "ADJUST",
  "PACKAGE",
  "SHOP",
  "BOOKING",
  /**
   * Balance carried over from a previous system during migration. A distinct
   * type so an imported balance is always visibly an import, never mistaken
   * for money SEIKA actually took (plan N4).
   */
  "OPENING_BALANCE",
] as const;
export type WalletTxnType = (typeof WalletTxnType)[number];

export const CoinTxnType = ["LEVELUP", "EVENT", "SPEND", "REVERSAL"] as const;
export type CoinTxnType = (typeof CoinTxnType)[number];

/** System roles. Owners can create custom roles on top of these (RBAC). */
export const SystemRole = [
  "SUPER_ADMIN",
  "ZONE_OWNER",
  "BRANCH_MANAGER",
  "CASHIER",
  "TECHNICIAN",
  "EVENT_MANAGER",
] as const;
export type SystemRole = (typeof SystemRole)[number];

export const RANKS = [
  { rank: "Rookie", min: 1, max: 10 },
  { rank: "Bronze", min: 11, max: 20 },
  { rank: "Silver", min: 21, max: 35 },
  { rank: "Gold", min: 36, max: 50 },
  { rank: "Platinum", min: 51, max: 65 },
  { rank: "Diamond", min: 66, max: 80 },
  { rank: "Elite", min: 81, max: 95 },
  { rank: "SEIKA Legend", min: 96, max: 100 },
] as const;
