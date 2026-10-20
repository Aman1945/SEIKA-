"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

/**
 * Finds the games already installed on this PC.
 *
 * Staff were being asked to paste a launcher URL and then find a process name
 * in Task Manager. That is a lot to get right while a player waits, and the
 * two things it asks for are both already written on disk: Epic and Steam
 * each keep a manifest for every game they installed.
 *
 * So this reads them. Each result carries what the kiosk actually needs:
 * how to start it, what it runs as, and where it lives — the last one being
 * what closes a cracked or renamed build when time runs out.
 */

/** Steam's install directory, from the registry, falling back to the usual place. */
function steamRoot() {
  try {
    const out = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', {
      encoding: "utf8",
      windowsHide: true,
      timeout: 4000,
    });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) return m[1].trim().replace(/\//g, "\\");
  } catch {
    // Not installed, or no permission to read that key.
  }
  for (const guess of ["C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam"]) {
    if (fs.existsSync(guess)) return guess;
  }
  return null;
}

/**
 * Every Steam library on this machine.
 *
 * Games are rarely all on C: — a zone puts them on whichever drive has room,
 * and libraryfolders.vdf is the only record of where those are.
 */
function steamLibraries(root) {
  const libs = [path.join(root, "steamapps")];
  const vdf = path.join(root, "steamapps", "libraryfolders.vdf");
  try {
    const text = fs.readFileSync(vdf, "utf8");
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
      const p = path.join(m[1].replace(/\\\\/g, "\\"), "steamapps");
      if (!libs.includes(p)) libs.push(p);
    }
  } catch {
    // One library then, which is the common case anyway.
  }
  return libs.filter((l) => fs.existsSync(l));
}

function detectSteam() {
  const root = steamRoot();
  if (!root) return [];
  const found = [];

  for (const lib of steamLibraries(root)) {
    let files = [];
    try {
      files = fs.readdirSync(lib).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const text = fs.readFileSync(path.join(lib, file), "utf8");
        const appid = text.match(/"appid"\s+"(\d+)"/i)?.[1];
        const name = text.match(/"name"\s+"([^"]+)"/i)?.[1];
        const dir = text.match(/"installdir"\s+"([^"]+)"/i)?.[1];
        if (!appid || !name) continue;

        const installDir = dir ? path.join(lib, "common", dir) : null;
        found.push({
          source: "Steam",
          name,
          // Steam's own protocol, so it handles updates, DRM and the overlay
          // exactly as it would if the player had clicked it in the client.
          launch: `steam://rungameid/${appid}`,
          // Guessed from the folder, and refined below where the exe is
          // obvious. The directory is what the close actually relies on.
          process: null,
          dir: installDir,
          installed: installDir ? fs.existsSync(installDir) : false,
        });
      } catch {
        // A manifest mid-write during an update; skip it.
      }
    }
  }
  return found;
}

/** The biggest .exe in a folder is nearly always the game itself. */
function likelyExe(dir) {
  try {
    const skip = /unins|setup|redist|vcredist|directx|crash|launcher_?helper|dotnet/i;
    let best = null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.exe$/i.test(entry.name) || skip.test(entry.name)) continue;
      const size = fs.statSync(path.join(dir, entry.name)).size;
      if (!best || size > best.size) best = { name: entry.name, size };
    }
    return best?.name ?? null;
  } catch {
    return null;
  }
}

function detectEpic() {
  const base = path.join(
    process.env.ProgramData || "C:\\ProgramData",
    "Epic",
    "EpicGamesLauncher",
    "Data",
    "Manifests"
  );
  if (!fs.existsSync(base)) return [];

  const found = [];
  for (const file of fs.readdirSync(base).filter((f) => f.endsWith(".item"))) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(base, file), "utf8"));
      if (!m.DisplayName || !m.AppName) continue;
      found.push({
        source: "Epic",
        name: m.DisplayName,
        launch: `com.epicgames.launcher://apps/${m.AppName}?action=launch&silent=true`,
        // Epic records the executable, which is the name the game runs under
        // — the thing that would otherwise be hunted for in Task Manager.
        process: m.LaunchExecutable ? path.basename(m.LaunchExecutable) : null,
        dir: m.InstallLocation || null,
        installed: m.InstallLocation ? fs.existsSync(m.InstallLocation) : false,
      });
    } catch {
      // A manifest being rewritten by the launcher; skip it.
    }
  }
  return found;
}

/**
 * Everything we can find, Epic and Steam together.
 *
 * Steam does not record an executable, so it is filled in from the install
 * folder: the largest .exe that is not an uninstaller or a redistributable.
 * It is a guess, and the install directory is what the session actually uses
 * to close the game, so a wrong guess costs nothing.
 */
function detectGames() {
  if (process.platform !== "win32") return [];
  const games = [...detectEpic(), ...detectSteam()];

  for (const g of games) {
    if (!g.process && g.dir && g.installed) g.process = likelyExe(g.dir);
  }

  return games
    .filter((g) => g.installed)
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { detectGames, steamRoot };
