"use strict";

/**
 * Smart Sync client — the half that touches the disk.
 *
 * The rule this file exists to respect: **the server decides what may sync.**
 * The kiosk enumerates candidate files and asks the API to screen them; only
 * paths the API allowed are ever read, and only those are ever written back.
 * Nothing here maintains its own allow-list, because a second copy of that
 * policy is a second place for it to be wrong — and being wrong here means
 * uploading a player's browser cookies or getting them banned by an anti-cheat.
 */

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/** Never walk into these while enumerating — cheap, and saves a huge scan. */
const SKIP_DIRS = new Set(["node_modules", ".git", "cache", "Cache", "logs", "Crashes"]);

/** A bundle over this is not a settings file; refuse before uploading. */
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 200;

/**
 * Where a game keeps its settings on this machine. Resolved from the
 * per-PC config, so a zone with a different install layout does not need a
 * different build.
 */
function gameRoot(config, game) {
  const configured = config.gameRoots?.[game];
  if (configured) return configured;
  // Sensible Windows default; a zone that installs elsewhere sets gameRoots.
  return path.join(os.homedir(), "Documents", "My Games", game);
}

/** Every file under `root`, as paths relative to it. */
async function enumerate(root) {
  const out = [];

  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // a missing or unreadable directory is simply nothing to sync
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }

  await walk(root, "");
  return out;
}

/**
 * Reads the files the server approved into a bundle.
 *
 * `allowed` comes from the API's screening call. A path that is not in it is
 * not read — not skipped later, not read.
 */
async function collect(root, allowed) {
  const files = {};
  let bytes = 0;

  for (const rel of allowed) {
    const full = path.join(root, rel);

    // Belt and braces against a path that escapes the game's own directory,
    // even though the server refuses traversal too.
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) continue;

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;

    bytes += stat.size;
    if (bytes > MAX_BUNDLE_BYTES) break;

    try {
      files[rel] = (await fs.readFile(resolved)).toString("base64");
    } catch {
      // An unreadable file is not worth failing the whole sync over.
    }
  }

  return { files, bytes };
}

/**
 * Writes a downloaded bundle back to disk.
 *
 * Each path is re-screened by the server before being written: a config stored
 * months ago under an older, wider policy must not be able to write somewhere
 * that policy no longer allows.
 */
async function apply(root, bundle, allowed) {
  const allowSet = new Set(allowed);
  const written = [];

  for (const [rel, b64] of Object.entries(bundle.files ?? {})) {
    if (!allowSet.has(rel)) continue;

    const resolved = path.resolve(path.join(root, rel));
    if (!resolved.startsWith(path.resolve(root) + path.sep)) continue;

    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      // Write to a temp file and rename: a half-written config file is worse
      // than an old one, and a game may be reading it.
      const tmp = `${resolved}.seika-tmp`;
      await fs.writeFile(tmp, Buffer.from(b64, "base64"));
      await fs.rename(tmp, resolved);
      written.push(rel);
    } catch {
      // Keep going; one unwritable file should not abort the restore.
    }
  }

  return written;
}

/** True when this machine has anything at all for that game. */
function hasGame(config, game) {
  try {
    return fsSync.existsSync(gameRoot(config, game));
  } catch {
    return false;
  }
}

module.exports = {
  gameRoot,
  enumerate,
  collect,
  apply,
  hasGame,
  MAX_BUNDLE_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
};
