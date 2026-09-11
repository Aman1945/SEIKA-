import mongoose from "mongoose";

import { GameSyncProfile, PlayerGameConfig } from "../../models/GameSyncProfile.js";
import { Session } from "../../models/Session.js";
import { badRequest, conflict, forbidden, notFound } from "../../common/errors.js";
import { audit } from "../audit/audit.service.js";

/** Largest config bundle we accept per game. Saves, not media libraries. */
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Directory names that must never sync, wherever they appear in a path.
 *
 * These are the categories the plan calls out (K5): browsers, chat clients and
 * anything private. A player's Chrome profile holds session cookies; a Discord
 * token is a full account takeover. None of it is a game setting, so none of it
 * is ever carried between PCs — no matter what a kiosk asks for.
 */
const FORBIDDEN_SEGMENTS = [
  // Browsers
  "chrome", "google\\chrome", "firefox", "mozilla", "edge", "msedge", "opera", "brave", "chromium",
  // Chat / social
  "discord", "discordptb", "discordcanary", "telegram", "whatsapp", "slack", "skype", "signal",
  // Credential and key stores
  "appdata\\roaming\\microsoft\\credentials", "ssh", ".ssh", "keychain", "wallets", "wallet",
  "password", "passwords", "login data", "cookies", "credentials", "tokens",
  // Personal files
  "documents", "desktop", "downloads", "pictures", "videos", "music", "onedrive", "dropbox",
  // OS / system
  "windows", "system32", "programdata\\microsoft", "boot", "recovery",
];

/**
 * Anti-cheat surfaces. Syncing these between machines is how a legitimate
 * player gets flagged as a cheater, so they are refused even inside a game's
 * own directory and even if a profile lists them (plan K6).
 */
const ANTICHEAT_SEGMENTS = [
  "easyanticheat", "eac", "battleye", "be", "vanguard", "vgk", "vgc",
  "punkbuster", "faceit", "esea", "anticheat", "ac_client",
  "gameguard", "xigncode", "nprotect", "hshield", "ricochet",
];

/** Extensions that are executable or driver-like — never a setting. */
const FORBIDDEN_EXTENSIONS = [
  ".exe", ".dll", ".sys", ".bat", ".cmd", ".ps1", ".sh", ".msi", ".scr", ".com", ".vbs", ".jar",
];

export interface PathDecision {
  path: string;
  allowed: boolean;
  reason?: string;
  /** True when the refusal was specifically an anti-cheat surface. */
  antiCheat?: boolean;
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
}

function segments(p: string): string[] {
  return normalize(p).toLowerCase().split("/").filter(Boolean);
}

/**
 * Decides whether one reported path may sync for a game.
 *
 * Order matters: structural checks first (a traversal is refused before we ask
 * what folder it claims to be in), then anti-cheat, then the forbidden list,
 * then the profile's own whitelist. A path must be *positively* allowed by the
 * profile — an empty whitelist syncs nothing.
 */
export function decidePath(params: {
  path: string;
  syncPaths: string[];
  excludePaths: string[];
}): PathDecision {
  const raw = params.path ?? "";
  const path = normalize(raw);

  if (!path) return { path: raw, allowed: false, reason: "Empty path" };

  // Absolute paths and traversal: a kiosk may only name paths relative to the
  // game's own directory.
  if (/^[a-z]:/i.test(path) || path.startsWith("/") || path.startsWith("//")) {
    return { path: raw, allowed: false, reason: "Absolute paths are not syncable" };
  }
  if (segments(path).includes("..")) {
    return { path: raw, allowed: false, reason: "Path traversal is not allowed" };
  }
  if (path.includes("\0")) {
    return { path: raw, allowed: false, reason: "Illegal character in path" };
  }

  const lower = path.toLowerCase();
  const segs = segments(path);

  const ext = lower.slice(lower.lastIndexOf("."));
  if (FORBIDDEN_EXTENSIONS.includes(ext)) {
    return { path: raw, allowed: false, reason: `Executable or driver files never sync (${ext})` };
  }

  // Anti-cheat check runs before the whitelist, so a mis-configured profile
  // cannot opt a zone into getting its players banned.
  const acHit = ANTICHEAT_SEGMENTS.find((seg) => segs.includes(seg));
  if (acHit) {
    return {
      path: raw,
      allowed: false,
      antiCheat: true,
      reason: `Anti-cheat path excluded (${acHit})`,
    };
  }

  const forbidden = FORBIDDEN_SEGMENTS.find((seg) => {
    const segLower = seg.replace(/\\/g, "/").toLowerCase();
    return segLower.includes("/") ? lower.includes(segLower) : segs.includes(segLower);
  });
  if (forbidden) {
    return { path: raw, allowed: false, reason: `Private or system path refused (${forbidden})` };
  }

  // The profile's own exclusions — narrower carve-outs inside allowed roots.
  const excluded = params.excludePaths.find((ex) => lower.startsWith(normalize(ex).toLowerCase()));
  if (excluded) {
    return { path: raw, allowed: false, reason: `Excluded by the game's sync profile (${excluded})` };
  }

  const allowedBy = params.syncPaths.find((root) => {
    const r = normalize(root).toLowerCase().replace(/\/$/, "");
    return lower === r || lower.startsWith(`${r}/`);
  });
  if (!allowedBy) {
    return { path: raw, allowed: false, reason: "Not inside a whitelisted sync folder" };
  }

  return { path: raw, allowed: true };
}

/** Games a zone may sync — only vetted, enabled profiles (plan K1). */
export async function supportedGames() {
  const profiles = await GameSyncProfile.find({ enabled: true })
    .select("game syncPaths excludePaths notes")
    .sort({ game: 1 })
    .lean();
  return profiles.map((p) => ({
    game: p.game,
    syncPaths: p.syncPaths,
    excludePaths: p.excludePaths,
    notes: p.notes ?? null,
  }));
}

async function enabledProfile(game: string) {
  const profile = await GameSyncProfile.findOne({ game });
  if (!profile) throw notFound(`No sync profile for ${game}`);
  if (!profile.enabled) throw forbidden(`Smart Sync is not enabled for ${game}`);
  return profile;
}

/**
 * A live session for this player, which is the precondition for syncing: config
 * comes down when they sit at an authorized PC, and goes up when they finish.
 */
async function liveSession(playerId: string) {
  const session = await Session.findOne({
    playerId,
    status: { $in: ["AUTHORIZED", "ACTIVE", "PAUSED", "LOW_BALANCE"] },
  })
    .sort({ createdAt: -1 })
    .select("_id pcId zoneId game");
  if (!session) throw badRequest("Smart Sync needs an authorized session");
  return session;
}

/** Screens a list of paths without transferring anything (kiosk pre-flight). */
export async function screenPaths(params: { game: string; paths: string[] }) {
  const profile = await enabledProfile(params.game);
  const decisions = params.paths.map((path) =>
    decidePath({
      path,
      syncPaths: profile.syncPaths as string[],
      excludePaths: profile.excludePaths as string[],
    })
  );
  return {
    game: params.game,
    allowed: decisions.filter((d) => d.allowed).map((d) => d.path),
    refused: decisions.filter((d) => !d.allowed),
  };
}

/** Download step (plan K2): the player's stored config for this game. */
export async function downloadConfig(params: { playerId: string; game: string }) {
  await enabledProfile(params.game);
  await liveSession(params.playerId);

  const stored = await PlayerGameConfig.findOne({
    playerId: params.playerId,
    game: params.game,
  }).lean();

  if (!stored) {
    // First time on this game: nothing to restore, and that is not an error.
    return { game: params.game, version: 0, payload: null as string | null, exists: false };
  }
  return {
    game: params.game,
    version: stored.version,
    payload: stored.payload,
    exists: true,
    updatedAt: stored.updatedAt,
    pcId: stored.pcId ? String(stored.pcId) : null,
  };
}

/**
 * Upload step (plan K3). The kiosk sends the bundle plus the list of files it
 * packed; the server screens every path and refuses the whole upload if any of
 * them should not have left the machine — a partially-screened bundle is not
 * something to store and hope about.
 *
 * `baseVersion` is what the kiosk downloaded. A mismatch means another PC wrote
 * in between, which is a conflict, not something to overwrite (plan K4).
 */
export async function uploadConfig(params: {
  playerId: string;
  game: string;
  payload: string;
  paths: string[];
  baseVersion: number;
  /** "latest" overwrites deliberately; "keep" aborts. Default: report and abort. */
  onConflict?: "abort" | "overwrite";
}) {
  const profile = await enabledProfile(params.game);
  const session = await liveSession(params.playerId);

  const bytes = Buffer.byteLength(params.payload, "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw badRequest(
      `Config bundle is ${Math.round(bytes / 1024)}KB; the limit is ${MAX_PAYLOAD_BYTES / 1024}KB`
    );
  }

  const decisions = params.paths.map((path) =>
    decidePath({
      path,
      syncPaths: profile.syncPaths as string[],
      excludePaths: profile.excludePaths as string[],
    })
  );
  const refused = decisions.filter((d) => !d.allowed);

  if (refused.length) {
    // Refusals are logged whether or not anyone is watching: an anti-cheat or
    // private-folder attempt is exactly the thing support needs to see later.
    await audit({
      actorId: params.playerId,
      actorType: "player",
      zoneId: String(session.zoneId),
      action: refused.some((r) => r.antiCheat)
        ? "SMARTSYNC_ANTICHEAT_BLOCKED"
        : "SMARTSYNC_PATH_BLOCKED",
      entityType: "smartsync",
      entityId: params.game,
      newValue: { refused: refused.map((r) => ({ path: r.path, reason: r.reason })) },
    });

    throw forbidden(
      `${refused.length} path(s) cannot sync: ${refused.map((r) => `${r.path} — ${r.reason}`).join("; ")}`
    );
  }

  const existing = await PlayerGameConfig.findOne({
    playerId: params.playerId,
    game: params.game,
  });

  if (!existing) {
    const created = await PlayerGameConfig.create({
      playerId: new mongoose.Types.ObjectId(params.playerId),
      game: params.game,
      version: 1,
      payload: params.payload,
      pcId: session.pcId,
      zoneId: session.zoneId,
      sizeBytes: bytes,
    });
    return { game: params.game, version: created.version, conflict: false as const };
  }

  if (existing.version !== params.baseVersion) {
    if (params.onConflict !== "overwrite") {
      throw conflict(
        `Your settings were changed on another PC (stored version ${existing.version}, ` +
          `you started from ${params.baseVersion}). Choose which copy to keep.`
      );
    }
  }

  existing.version = existing.version + 1;
  existing.payload = params.payload;
  existing.set("pcId", session.pcId);
  existing.set("zoneId", session.zoneId);
  existing.sizeBytes = bytes;
  await existing.save();

  return {
    game: params.game,
    version: existing.version,
    conflict: existing.version - 1 !== params.baseVersion,
  };
}
