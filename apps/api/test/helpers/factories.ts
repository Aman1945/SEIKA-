import mongoose from "mongoose";
import request from "supertest";
import type { Express } from "express";

import { createApp } from "../../src/app.js";
import { Zone, Branch } from "../../src/models/Zone.js";
import { PC } from "../../src/models/PC.js";
import { Player } from "../../src/models/Player.js";
import { StaffUser } from "../../src/models/StaffUser.js";
import { Product } from "../../src/models/Product.js";
import { signAccessToken } from "../../src/common/jwt.js";
import { signQrToken } from "../../src/common/qr.js";
import { addWalletEntry } from "../../src/modules/wallet/wallet.service.js";

/** The Express app under test — built once, reused by every case. */
let app: Express | undefined;
export function api(): Express {
  app ??= createApp();
  return app;
}

export type StaffRole =
  | "SUPER_ADMIN"
  | "ZONE_OWNER"
  | "BRANCH_MANAGER"
  | "CASHIER"
  | "TECHNICIAN"
  | "EVENT_MANAGER";

export interface SeededZone {
  zoneId: string;
  branchId: string;
  pcId: string;
  pcClientKey: string;
  hourlyRate: number;
  ownerId: string;
  ownerToken: string;
}

/**
 * A complete zone: owner, branch, one PC at a known hourly rate. Tests that
 * need tenant isolation (plan M5/M6) just seed two of these.
 */
export async function seedZone(
  opts: { name?: string; hourlyRate?: number; city?: string; country?: string } = {}
): Promise<SeededZone> {
  const hourlyRate = opts.hourlyRate ?? 60;
  const owner = await StaffUser.create({
    role: "ZONE_OWNER",
    name: `Owner ${opts.name ?? "A"}`,
    email: `owner_${new mongoose.Types.ObjectId()}@seika.test`,
  });
  const zone = await Zone.create({
    ownerId: owner._id,
    name: opts.name ?? "Test Zone",
    country: opts.country ?? "India",
    city: opts.city ?? "Mumbai",
    verified: true,
  });
  owner.set("zoneId", zone._id);
  await owner.save();

  const branch = await Branch.create({ zoneId: zone._id, name: "Main Branch" });
  const pc = await PC.create({
    zoneId: zone._id,
    branchId: branch._id,
    pcNumber: "PC-01",
    hourlyRate: mongoose.Types.Decimal128.fromString(hourlyRate.toFixed(2)),
    category: "standard",
    clientKey: `key-${new mongoose.Types.ObjectId()}`,
  });

  return {
    zoneId: String(zone._id),
    branchId: String(branch._id),
    pcId: String(pc._id),
    pcClientKey: pc.clientKey as string,
    hourlyRate,
    ownerId: String(owner._id),
    ownerToken: staffToken(String(owner._id), "ZONE_OWNER", String(zone._id)),
  };
}

/** Extra PC in an existing zone (booking-conflict and PC-map cases need two). */
export async function seedPc(
  zone: SeededZone,
  opts: { pcNumber?: string; hourlyRate?: number } = {}
): Promise<{ pcId: string; clientKey: string }> {
  const pc = await PC.create({
    zoneId: new mongoose.Types.ObjectId(zone.zoneId),
    branchId: new mongoose.Types.ObjectId(zone.branchId),
    pcNumber: opts.pcNumber ?? `PC-${Math.floor(Math.random() * 900 + 100)}`,
    hourlyRate: mongoose.Types.Decimal128.fromString((opts.hourlyRate ?? zone.hourlyRate).toFixed(2)),
    category: "standard",
    clientKey: `key-${new mongoose.Types.ObjectId()}`,
  });
  return { pcId: String(pc._id), clientKey: pc.clientKey as string };
}

export async function seedStaff(
  zone: SeededZone,
  role: StaffRole,
  opts: { phone?: string } = {}
): Promise<{ staffId: string; token: string; phone: string }> {
  const phone = opts.phone ?? `97${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
  const staff = await StaffUser.create({
    role,
    name: `${role} user`,
    phone,
    zoneId: new mongoose.Types.ObjectId(zone.zoneId),
  });
  return {
    staffId: String(staff._id),
    phone,
    token: staffToken(String(staff._id), role, zone.zoneId),
  };
}

/**
 * A player, optionally funded. Funding goes through the real ledger service —
 * never a direct balance write — so the "balance == SUM(ledger)" invariant
 * (plan D1/D2) holds in fixtures too.
 */
export async function seedPlayer(
  opts: { balance?: number; zoneId?: string; city?: string; country?: string; name?: string } = {}
): Promise<{ playerId: string; token: string; phone: string }> {
  const phone = `98${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
  const player = await Player.create({
    name: opts.name ?? "Test Player",
    username: `player_${new mongoose.Types.ObjectId().toString().slice(-8)}`,
    phone,
    otpVerified: true,
    city: opts.city,
    country: opts.country,
  });
  const playerId = String(player._id);

  if (opts.balance && opts.zoneId) {
    await addWalletEntry({
      playerId,
      zoneId: opts.zoneId,
      amount: opts.balance,
      type: "TOPUP",
      method: "CASH",
      createdBy: "test-fixture",
    });
  }

  return { playerId, phone, token: playerToken(playerId) };
}

export async function seedProduct(
  zone: SeededZone,
  opts: { name?: string; price?: number; stockQty?: number; lowStockThreshold?: number } = {}
): Promise<{ productId: string; price: number }> {
  const price = opts.price ?? 50;
  const product = await Product.create({
    zoneId: new mongoose.Types.ObjectId(zone.zoneId),
    name: opts.name ?? "Cola",
    category: "beverage",
    price: mongoose.Types.Decimal128.fromString(price.toFixed(2)),
    stockQty: opts.stockQty ?? 10,
    lowStockThreshold: opts.lowStockThreshold ?? 3,
    active: true,
  });
  return { productId: String(product._id), price };
}

export function playerToken(playerId: string): string {
  return signAccessToken({ sub: playerId, typ: "player" });
}

export function staffToken(staffId: string, role: StaffRole, zoneId?: string): string {
  return signAccessToken({ sub: staffId, typ: "staff", role, zoneId });
}

/** Fresh QR token for a PC — what the kiosk screen would display. */
export function qrFor(pcId: string): string {
  return signQrToken(pcId).token;
}

/** `as(token).get("/api/...")` — a supertest agent with the auth header set. */
export function as(token: string) {
  const agent = request(api());
  const wrap =
    (method: "get" | "post" | "patch" | "put" | "delete") =>
    (url: string) =>
      agent[method](url).set("authorization", `Bearer ${token}`);
  return {
    get: wrap("get"),
    post: wrap("post"),
    patch: wrap("patch"),
    put: wrap("put"),
    delete: wrap("delete"),
  };
}

/** Unauthenticated agent. */
export function anon() {
  return request(api());
}

/**
 * Drives the full core loop: QR attach → authorize → start. Returns the session
 * id. Used by every case that needs an ACTIVE session to act on.
 */
export async function startActiveSession(params: {
  zone: SeededZone;
  playerToken: string;
  pcId?: string;
  source?: "WALLET" | "CASH" | "PACKAGE" | "VOUCHER" | "POSTPAID" | "BOOKING";
  sessionMode?: "FIXED_DURATION" | "OPEN_HOUR";
  selectedMinutes?: number;
  voucherCode?: string;
  /** Token used for authorize (CASH needs a staff token). */
  authorizeToken?: string;
}): Promise<string> {
  const pcId = params.pcId ?? params.zone.pcId;
  const attach = await as(params.playerToken)
    .post("/api/sessions/attach")
    .send({ qrToken: qrFor(pcId) });
  if (attach.status !== 201) {
    throw new Error(`attach failed: ${attach.status} ${JSON.stringify(attach.body)}`);
  }
  const sessionId = attach.body.sessionId as string;

  const authRes = await as(params.authorizeToken ?? params.playerToken)
    .post(`/api/sessions/${sessionId}/authorize`)
    .send({
      source: params.source ?? "WALLET",
      sessionMode: params.sessionMode,
      selectedMinutes: params.selectedMinutes,
      voucherCode: params.voucherCode,
    });
  if (authRes.status !== 200) {
    throw new Error(`authorize failed: ${authRes.status} ${JSON.stringify(authRes.body)}`);
  }

  const start = await as(params.playerToken).post(`/api/sessions/${sessionId}/start`).send({});
  if (start.status !== 200) {
    throw new Error(`start failed: ${start.status} ${JSON.stringify(start.body)}`);
  }
  return sessionId;
}

/**
 * Backdates an active session's start time so ending it yields a known number
 * of valid minutes — the only way to assert XP/billing without real waiting.
 */
export async function backdateSessionStart(sessionId: string, minutes: number): Promise<void> {
  const { Session } = await import("../../src/models/Session.js");
  await Session.updateOne(
    { _id: sessionId },
    { $set: { startTime: new Date(Date.now() - minutes * 60_000) } }
  );
}
