"use strict";

/**
 * SEIKA PC Client — Electron main process.
 *
 * This process owns three things the renderer must not: the physical lock, the
 * heartbeat, and the disk. The unlock decision itself is never made here — it
 * arrives from the server, which is the whole point of the product's core rule.
 */

const { app, shell, dialog, BrowserWindow, globalShortcut, ipcMain, powerSaveBlocker } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const { io } = require("socket.io-client");
const QRCode = require("qrcode");

const { KioskApi } = require("./src/api");
const smartsync = require("./src/smartsync");
const { detectGames, steamRoot } = require("./src/detect");
const { signOutLaunchers } = require("./src/launchers");

/** How often to tell the server this PC is alive (plan B8). */
const HEARTBEAT_MS = 20_000;
/** QR tokens live 60s server-side; refresh well inside that. */
const QR_REFRESH_MS = 40_000;

let win = null;
let config = null;
let api = null;
let socket = null;
let heartbeatTimer = null;
let qrTimer = null;
let powerBlocker = null;
/** Locked until the server says otherwise. Never the other way round. */
let locked = true;

/**
 * Recovery mode: the config could not be loaded, so this PC cannot identify
 * itself, cannot start a session and cannot be unlocked by the server. It is
 * not a kiosk — it is a locked screen with no way out.
 *
 * Staying locked here protects nothing. There is no session to end, no money
 * to lose, and nobody can be billed. The only thing the lock achieves is
 * trapping whoever is standing in front of it, and the staff escape does not
 * help because that is configured in the very file that failed to load.
 *
 * So in this state, and only this state, the kiosk offers a plain way out.
 */
/**
 * The last state each push channel sent.
 *
 * The renderer only learns about the socket, the heartbeat and the QR from
 * pushes, and those fire on change. If the window is recreated — a crash, a
 * closed window, the watchdog — the new page starts blank and no event is
 * coming, because nothing changed. The kiosk then sits on "Connecting…" with
 * no QR while being perfectly connected, and a player cannot scan a PC that
 * is working fine.
 */
let lastConnected = false;
let lastHeartbeatOk = false;
let lastQr = null;
/** What the launcher needs to draw itself; set when the server unlocks us. */
let lastSession = null;

let recoveryMode = false;
let recoveryReason = "";
/** Set when an exit was authorised, so window-all-closed stops fighting it. */
let exiting = false;

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Where a packaged kiosk keeps its config.
 *
 * Every gaming PC needs its own pcId and clientKey, so the config cannot live
 * in the build — and it cannot live next to main.js either, because that is
 * inside app.asar and read-only once packaged. An installed kiosk that looked
 * only there could never be configured at all.
 *
 * ProgramData first: the installer runs per-machine, so it can write there,
 * every user account can read it, and it survives an app update.
 */
function configCandidates() {
  const paths = [];
  if (process.env.SEIKA_CONFIG) paths.push(process.env.SEIKA_CONFIG);
  if (process.platform === "win32") {
    const programData = process.env.ProgramData || "C:\\ProgramData";
    paths.push(path.join(programData, "SEIKA", "config.js"));
  }
  try {
    paths.push(path.join(app.getPath("userData"), "config.js"));
  } catch {
    // app may not be ready yet in some call paths; the others still apply.
  }
  // Beside the installed executable, for an admin who would rather keep it there.
  paths.push(path.join(path.dirname(app.getPath("exe")), "config.js"));
  // Last: the source tree, which is how it works in development.
  paths.push(path.join(__dirname, "config.js"));
  return paths;
}

function loadConfig() {
  const candidates = configCandidates();
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    throw new Error(
      "config.js not found. Copy config.example.js, fill in the pcId and " +
        "clientKey from the zone console, and save it as:\n  " +
        candidates.join("\n  ")
    );
  }
  // config.js assigns to window.SEIKA_CONFIG so the same file can be loaded by
  // the renderer; read it here with a tiny shim rather than keeping two files.
  const sandbox = { window: {} };
  const source = fs.readFileSync(file, "utf8");
  new Function("window", source)(sandbox.window);
  const cfg = sandbox.window.SEIKA_CONFIG;

  for (const key of ["apiUrl", "pcId", "clientKey"]) {
    if (!cfg?.[key] || String(cfg[key]).includes("PUT_")) {
      throw new Error(`${file} is missing ${key}.`);
    }
  }
  cfg.__source = file;
  cfg.wsUrl = cfg.wsUrl || cfg.apiUrl;
  return cfg;
}

// ─── Window and the physical lock ────────────────────────────────────────────

/**
 * Windowed mode for local development.
 *
 * The kiosk takes the whole screen and re-asserts itself every second, which
 * is correct on a gaming PC and makes the thing untestable anywhere else — you
 * cannot watch it behave because it has taken the machine you are watching on.
 *
 * Honoured only in an unpackaged build. An installed kiosk ignores the
 * variable entirely, so this cannot be used to get a free PC.
 */
const WINDOWED = !app.isPackaged && process.env.SEIKA_WINDOWED === "1";

function createWindow() {
  win = new BrowserWindow({
    ...(WINDOWED
      ? { width: 1100, height: 760, fullscreen: false, kiosk: false, alwaysOnTop: false, frame: true, closable: true }
      : { fullscreen: true, kiosk: true, alwaysOnTop: true, frame: false, closable: false }),
    minimizable: WINDOWED,
    skipTaskbar: !WINDOWED,
    backgroundColor: "#0a0c12",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The lock screen loads only local files; it has no reason to navigate.
      sandbox: true,
      // The launcher embeds the player app in a <webview>, which is isolated
      // from this page: it gets no preload and no node, so the remote page
      // cannot reach the lock, the config or the game launcher.
      webviewTag: true,
    },
  });

  // Replay the current state to every fresh page. Without this, a window that
  // is recreated shows "Connecting…" and no QR until something happens to
  // change — which, on a healthy kiosk, is never.
  win.webContents.on("did-finish-load", () => {
    send("seika:connection", { connected: lastConnected });
    send("seika:heartbeat", { ok: lastHeartbeatOk });
    if (lastQr) send("seika:qr", lastQr);
    if (lastSession) send("seika:launcher", lastSession);
    if (recoveryMode) send("seika:fatal", { message: recoveryReason });
    // The QR expires in about a minute, so a stale one is worth refreshing
    // rather than showing a code that will fail when scanned.
    if (!recoveryMode && api) void refreshQrNow();
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.setAlwaysOnTop(true, "screen-saver");

  // A kiosk that goes to sleep mid-session locks the player out of a PC they
  // have paid for.
  powerBlocker = powerSaveBlocker.start("prevent-display-sleep");

  // Nothing in the lock screen should ever open a window or navigate away.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

/**
 * Shortcuts a player might use to get behind the lock screen.
 *
 * This list is the *second* line of defence, not the first. Electron's
 * globalShortcut cannot hold the Windows key or Ctrl+Alt+Del, so the real lock
 * is the Windows policy and keyboard work done by
 * `windows/Install-SeikaKiosk.ps1`. These catch what is left while the kiosk
 * has focus.
 */
const BLOCKED_SHORTCUTS = [
  "Alt+Tab",
  "Alt+Shift+Tab",
  "Super",
  "Super+D",
  "Super+E",
  "Super+R",
  "Super+L",
  "Super+M",
  "Super+Tab",
  "Super+Up",
  "Super+Down",
  "Alt+F4",
  "Alt+Escape",
  "Alt+Space",
  "Control+W",
  "Control+Shift+Esc",
  "Control+Escape",
  "Control+Alt+Delete", // never fires — registered so the intent is on record
  "F11",
];

function blockShortcuts() {
  for (const accel of BLOCKED_SHORTCUTS) {
    try {
      globalShortcut.register(accel, () => {});
    } catch {
      // Some accelerators are unavailable on some layouts. The Windows-level
      // lockdown is what production relies on, not this.
    }
  }
}

/**
 * Keeps the lock screen in front.
 *
 * A game launcher, an updater or a driver popup can take focus and leave a
 * usable sliver of desktop behind the overlay. On Windows that is the common
 * way a lock screen is beaten without any real effort, so while locked the
 * window re-asserts itself on a timer.
 */
let assertTimer = null;

function startAssertingLock() {
  stopAssertingLock();
  if (WINDOWED) return; // would fight the developer for focus once a second
  assertTimer = setInterval(() => {
    if (!locked || !win || win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    if (!win.isFocused()) {
      win.setAlwaysOnTop(true, "screen-saver");
      win.focus();
    }
  }, 1_000);
}

function stopAssertingLock() {
  if (assertTimer) clearInterval(assertTimer);
  assertTimer = null;
}

/** Where staff-added game paths are kept, separate from the installer's config. */
function gamesFile() {
  const dir =
    process.platform === "win32"
      ? path.join(process.env.ProgramData || "C:\\ProgramData", "SEIKA")
      : (config?.__source ? path.dirname(config.__source) : __dirname);
  return path.join(dir, "games.json");
}

/** config.js paths first, then anything staff added on this machine. */
function allGamePaths() {
  const fromConfig = config?.gamePaths ?? {};
  let added = {};
  try {
    const f = gamesFile();
    if (fs.existsSync(f)) added = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (err) {
    logger(`games.json unreadable: ${err.message}`);
  }
  return { ...fromConfig, ...added };
}

/**
 * Adds or removes a game, once the server has confirmed the caller is staff.
 *
 * The gate is the server, not this process: the kiosk asks the API whether
 * the supplied token belongs to staff of THIS zone. A player who reaches the
 * launcher cannot add a path, which matters because a path is an arbitrary
 * executable this machine will run.
 */
async function saveGame({ staffToken, name, exePath, procName, gameDir, remove }) {
  if (!api || !config) return { ok: false, reason: "This PC is not configured" };

  let who;
  try {
    who = await api.whoAmI(staffToken);
  } catch {
    return { ok: false, reason: "That sign-in did not work" };
  }
  if (who?.auth?.typ !== "staff") return { ok: false, reason: "Staff only" };
  if (String(who.auth.zoneId ?? "") !== String(config.zoneId ?? who.auth.zoneId)) {
    // Falls back to accepting the token's own zone when the PC was configured
    // without one; a mismatch when we do know is refused.
    if (config.zoneId) return { ok: false, reason: "That account is for another zone" };
  }

  const clean = String(name ?? "").trim();
  if (!clean) return { ok: false, reason: "Give the game a name" };

  const current = (() => {
    try {
      const f = gamesFile();
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    } catch {
      return {};
    }
  })();

  if (remove) {
    delete current[clean];
  } else {
    const p = String(exePath ?? "").trim().replace(/^"|"$/g, "");
    if (!p) return { ok: false, reason: "Give the path or launcher link" };

    if (isProtocolUrl(p)) {
      // Nothing on disk to check — the launcher owns it. The process name is
      // what lets the session end it later, so it is asked for here.
      const proc = String(procName ?? "").trim();
      if (!proc) {
        return {
          ok: false,
          reason:
            "A launcher link also needs the game's process name (e.g. GTA5.exe), " +
            "or the session cannot close it when time runs out.",
        };
      }
      current[clean] = { launch: p, process: proc, ...(gameDir ? { dir: gameDir } : {}) };
    } else {
      // Checked now rather than at launch, so the mistake is caught by the
      // person who can fix it instead of the player who cannot.
      if (!fs.existsSync(p)) return { ok: false, reason: `Nothing at ${p}` };
      const proc = String(procName ?? "").trim();
      const dir = String(gameDir ?? "").trim();
      current[clean] = proc || dir ? { launch: p, process: proc || null, ...(dir ? { dir } : {}) } : p;
    }
  }

  try {
    const f = gamesFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(current, null, 2));
  } catch (err) {
    return { ok: false, reason: `Could not save: ${err.message}` };
  }

  logger(`${remove ? "removed" : "added"} game ${clean} by staff ${who.auth.sub}`);
  const games = Object.keys(allGamePaths());
  if (lastSession) lastSession.games = games;
  send("seika:launcher", { ...(lastSession ?? {}), games });
  return { ok: true, games };
}

/**
 * Asks the server for a token for the player sitting here.
 *
 * They signed in on their phone to pay; asking again on the PC they just paid
 * for would be absurd. The machine proves itself with its clientKey and the
 * server decides who, if anyone, is seated — nothing about the player is
 * taken from this side.
 */
async function handoffForSeatedPlayer() {
  if (!api || !config) return;
  try {
    const res = await api.sessionHandoff(config.clientKey);
    const base = String(config.playerUrl ?? "").replace(/\/$/, "");
    if (!base) {
      send("seika:dashboard", { error: "No playerUrl is set on this PC" });
      return;
    }
    send("seika:dashboard", { url: `${base}/?handoff=${encodeURIComponent(res.accessToken)}` });
    // Authoritative timing, replacing whatever the unlock message carried.
    send("seika:launcher", {
      ...(lastSession ?? {}),
      startedAt: res.startedAt ?? null,
      endsAt: res.endsAt ?? null,
      sessionMode: res.sessionMode ?? "OPEN_HOUR",
      games: Object.keys(allGamePaths()),
    });
  } catch (err) {
    logger(`handoff failed: ${err.message}`);
    send("seika:dashboard", { error: "Could not load your profile" });
  }
}

/**
 * Starts a game the zone has configured on this machine.
 *
 * The renderer sends a NAME, never a path. Paths come only from config.js,
 * which is written by the installer and read-only to the player account — so
 * the lock screen cannot be talked into running an arbitrary executable even
 * if someone reaches its devtools. A name with no entry in config is simply
 * not a game this PC offers.
 */
/**
 * What a game entry can be.
 *
 * A string is a path, which is how most installed games work. An object is
 * for the ones that do not:
 *
 *   "Valorant": "C:/Riot Games/.../VALORANT.exe"
 *   "GTA V":    { launch: "com.epicgames.launcher://apps/xxx?action=launch",
 *                 process: "GTA5.exe" }
 *
 * Epic and Steam do not start a game by running an exe — they hand a URL to
 * their own launcher, which starts the game as ITS child, not ours. So the
 * thing we spawn exits immediately and the game we need to stop later is a
 * process we never owned. `process` names it, so the session can still end.
 */
function gameEntry(name) {
  const all = allGamePaths();
  if (!Object.prototype.hasOwnProperty.call(all, name)) return null;
  const v = all[name];
  return typeof v === "string" ? { launch: v, process: null } : { launch: v?.launch, process: v?.process ?? null };
}

/** Anything with a scheme is handed to the OS, not spawned. */
function isProtocolUrl(target) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(target)) && !/^file:/i.test(String(target));
}

/**
 * Never killed, even when they are sitting inside a game's folder.
 *
 * Anti-cheat is the part of a game most likely to take offence at being
 * force-killed, and it is the part we have no reason to touch: closing the
 * game it protects is enough, and EAC and BattlEye both exit on their own
 * once it does. Vanguard is a system service that long outlives any session.
 *
 * Force-closing a GAME is ordinary — it is what alt-F4 and a power cut look
 * like, and every game handles it. Force-closing its anti-cheat is not.
 */
const NEVER_KILL = [
  "easyanticheat.exe", "easyanticheat_eos.exe", "easyanticheat_setup.exe",
  "beservice.exe", "battleye.exe", "bedaisy.exe",
  "vgc.exe", "vgtray.exe",            // Riot Vanguard
  "steamservice.exe", "steamwebhelper.exe",
];

/** PIDs we started, and process names we were told to watch. */
const running = new Map(); // name -> { pid, process }

/**
 * Starts a game.
 *
 * The renderer sends a NAME, never a path. Targets come only from config, so
 * the lock screen cannot be talked into running an arbitrary executable even
 * by someone who reaches its devtools.
 */
function launchGame(name) {
  const entry = gameEntry(name);
  if (!entry?.launch) return { ok: false, reason: "That game is not set up on this PC" };
  const target = String(entry.launch);

  // Epic, Steam, anything with a scheme: the OS knows which launcher owns it.
  if (isProtocolUrl(target)) {
    return shell
      .openExternal(target)
      .then(() => {
        if (entry.process) running.set(name, { pid: null, process: entry.process });
        logger(`handed ${name} to the OS: ${target.split("?")[0]}`);
        return { ok: true };
      })
      .catch((err) => {
        logger(`launch failed ${name}: ${err.message}`);
        return { ok: false, reason: "The launcher for that game did not open" };
      });
  }

  if (!fs.existsSync(target)) {
    logger(`game missing on disk: ${name} -> ${target}`);
    return { ok: false, reason: "That game is not installed on this PC any more" };
  }

  // A Windows shortcut is not a program. Spawning a .lnk fails; the shell
  // has to resolve it.
  if (/\.(lnk|url)$/i.test(target)) {
    return shell
      .openPath(target)
      .then((err) => {
        if (err) {
          logger(`shortcut failed ${name}: ${err}`);
          return { ok: false, reason: "That shortcut did not open" };
        }
        running.set(name, {
          pid: null,
          process: entry.process ?? path.basename(target).replace(/\.(lnk|url)$/i, "") + ".exe",
        });
        logger(`opened shortcut ${name}`);
        return { ok: true };
      })
      .catch(() => ({ ok: false, reason: "That shortcut did not open" }));
  }

  // macOS will not start an .app by running the binary inside it.
  const isMacBundle = process.platform === "darwin" && target.includes(".app/");
  const cmd = isMacBundle ? "open" : target;
  const args = isMacBundle ? ["-a", target.split(".app/")[0] + ".app"] : [];

  return new Promise((resolve) => {
    let child;
    try {
      // Detached: the game must outlive the kiosk, not die with it.
      child = spawn(cmd, args, { detached: true, stdio: "ignore", cwd: path.dirname(target) });
    } catch (err) {
      logger(`launch failed ${name}: ${err.message}`);
      resolve({ ok: false, reason: `Could not start it: ${err.message}` });
      return;
    }

    let settled = false;
    const ok = () => {
      if (settled) return;
      settled = true;
      running.set(name, { pid: child.pid, process: entry.process ?? path.basename(target) });
      child.unref();
      logger(`launched ${name} (pid ${child.pid})`);
      resolve({ ok: true });
    };

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      logger(`launch failed ${name}: ${err.message}`);
      resolve({ ok: false, reason: `Could not start it: ${err.message}` });
    });

    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      // `open` on macOS is a hand-off that exits 0 immediately; so is a
      // game launcher that passes the job to itself.
      if (isMacBundle && code === 0) {
        // `open` has handed off and exited, so there is no pid to hold. The
        // bundle name is what the app actually runs as.
        running.set(name, {
          pid: null,
          process: entry.process ?? path.basename(target.split(".app/")[0]),
        });
        logger(`launched ${name}`);
        resolve({ ok: true });
        return;
      }
      logger(`${name} exited immediately with code ${code}`);
      resolve({
        ok: false,
        reason:
          "It closed as soon as it started. If this game runs through Epic or " +
          "Steam, it needs the launcher link rather than an .exe.",
      });
    });

    // Survived long enough to be real.
    setTimeout(ok, 2000);
  });
}

/**
 * Closes every game this session started.
 *
 * A session that ends while the player is still in a game has not really
 * ended — they keep playing on a PC that is supposed to be locked, and the
 * lock screen sits behind a fullscreen window. So the games go when the
 * session does.
 *
 * Killed by PID where we own the process, and by name where we do not: a game
 * started through Epic or Steam belongs to that launcher, not to us.
 */
function closeRunningGames(why) {
  /*
   * Every game this PC is set up to run, not only the ones we started.
   *
   * A player can have a game open from before the kiosk locked, or start one
   * some other way during a paid session. Closing only what we launched
   * leaves exactly that case playable behind a lock screen — which is the
   * case worth closing.
   */
  const configured = new Map();
  try {
    for (const [name, v] of Object.entries(allGamePaths())) {
      const target = typeof v === "string" ? v : v?.launch;
      const isUrl = isProtocolUrl(String(target ?? ""));
      configured.set(name, {
        pid: null,
        process: typeof v === "string" ? (isUrl ? null : path.basename(String(target))) : v?.process,
        // The folder the game lives in. This is what actually catches a
        // cracked build: a loader starts, launches the real executable under
        // a different name and exits, so the name we were given is not what
        // ends up running — but it is running from the same directory.
        dir: isUrl ? null : (typeof v === "string" ? path.dirname(String(target)) : (v?.dir ?? (v?.launch && !isProtocolUrl(v.launch) ? path.dirname(v.launch) : null))),
      });
    }
  } catch {
    // A broken config must not stop the lock from closing what it can.
  }

  const merged = new Map(configured);
  for (const [k, v] of running) merged.set(k, { ...(configured.get(k) ?? {}), ...v });
  const entries = [...merged.entries()];
  running.clear();
  if (entries.length === 0) return;

  for (const [name, { pid, process: procName, dir }] of entries) {
    try {
      if (process.platform === "win32") {
        // /T takes the children too — a launcher's game is a child of the
        // launcher, and killing only the parent leaves the game on screen.
        if (pid) spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).unref();
        if (procName && !NEVER_KILL.includes(String(procName).toLowerCase())) {
          // Graceful, then forced — same reasoning as the sweep below.
          spawn("taskkill", ["/IM", procName, "/T"], { stdio: "ignore", windowsHide: true }).unref();
          setTimeout(() => {
            try {
              spawn("taskkill", ["/IM", procName, "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
            } catch {}
          }, 4000);
        }

        if (dir) {
          // Kill by where it runs from, not what it is called. Matching on
          // the image name misses a cracked game whose loader renamed it, and
          // that is the case that leaves a player still playing after time is
          // up. Quotes doubled for PowerShell, and the kiosk excluded so this
          // can never take the lock screen down with it.
          const safe = String(dir).replace(/'/g, "''");
          spawn(
            "powershell",
            [
              "-NoProfile", "-NonInteractive", "-Command",
              // Anti-cheat is skipped by name. It lives in the game's folder,
              // so the directory match would otherwise take it, and that is
              // the one process worth being careful with.
              `$skip = @(${NEVER_KILL.map((n) => `'${n}'`).join(",")}); ` +
                `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${safe}\\*' -and $_.ProcessId -ne ${process.pid} -and $skip -notcontains $_.Name.ToLower() } | ` +
                // CloseMainWindow first: a game asked to close saves and exits
                // the way it would on alt-F4. Only what ignores that is forced.
                `ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { $null = $p.CloseMainWindow(); } }; ` +
                `Start-Sleep -Seconds 4; ` +
                `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${safe}\\*' -and $_.ProcessId -ne ${process.pid} -and $skip -notcontains $_.Name.ToLower() } | ` +
                `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
            ],
            { stdio: "ignore", windowsHide: true }
          ).unref();
        }
      } else {
        if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); } }
        if (procName) spawn("pkill", ["-9", "-f", procName], { stdio: "ignore" }).unref();
        if (dir) spawn("pkill", ["-9", "-f", String(dir)], { stdio: "ignore" }).unref();
      }
      logger(`closed ${name} (${why})`);
    } catch (err) {
      logger(`could not close ${name}: ${err.message}`);
    }
  }
}

/**
 * Gets the lock screen out of the way, leaving the player their desktop.
 *
 * On macOS a kiosk window lives in its own Space, and leaving full screen is
 * an animated, asynchronous transition. Hiding the window partway through
 * leaves the machine sitting in an empty Space — a blank screen with nothing
 * in it and no obvious way back, which is worse than staying locked. So leave
 * full screen first and hide only once macOS says it is done.
 *
 * Windows has no Spaces and hides immediately, which is why this was invisible
 * on the platform the kiosk actually ships to.
 */
function revealDesktop({ toDesktop = false } = {}) {
  if (!win || win.isDestroyed()) return;

  const state = (when) =>
    logger(
      `reveal ${when}: visible=${win.isVisible()} fullscreen=${win.isFullScreen()} kiosk=${win.isKiosk()}`
    );
  state("before");

  // The launcher stays on screen after the lock lifts — it is where the player
  // starts a game, watches their time and orders from their seat. It must not
  // behave like the lock, though: they need to reach the game they just
  // started, so it gives up focus, can be minimised, and is not on top.
  const finish = () => {
    if (locked || !win || win.isDestroyed()) return;
    win.setMinimizable(true);
    win.setClosable(true);
    win.setSkipTaskbar(false);
    if (toDesktop) win.hide();
    else win.show();
    state("after");
  };

  if (process.platform === "darwin" && (win.isKiosk() || win.isFullScreen())) {
    // On macOS a kiosk window lives in its own Space and leaving full screen
    // is animated and asynchronous. Acting partway through strands the machine
    // in an empty Space — a blank screen with no way back.
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      finish();
    };
    win.once("leave-full-screen", done);
    setTimeout(done, 1500);
    win.setKiosk(false);
    win.setFullScreen(false);
    return;
  }

  win.setKiosk(false);
  win.setFullScreen(false);
  finish();
}

/**
 * Applies the lock state.
 *
 * Locked is the resting state: if anything is unclear — no config, no network,
 * an unknown command — the PC stays locked. A kiosk that fails open is a kiosk
 * that gives away free play.
 */
function applyLock(next, reason, opts = {}) {
  locked = Boolean(next);
  if (!win || win.isDestroyed()) return;

  if (locked) {
    // Before the screen comes up, not after: the lock screen appearing over a
    // game the player is still in is not a locked PC.
    closeRunningGames(reason || "locked");
    // The games are closed; now the accounts behind them. A player's Steam
    // left signed in is the next customer's library, friends list and saved
    // card — a zone only has to get that wrong once.
    signOutLaunchers({ steamRoot: steamRoot(), log: logger });
    if (!WINDOWED) win.setKiosk(true);
    win.setAlwaysOnTop(true, "screen-saver");
    win.show();
    win.focus();
    blockShortcuts();
    startAssertingLock();
  } else {
    // Unlocked: the player needs the desktop and their games, so the lock
    // screen gets out of the way entirely. Hidden rather than minimised, so
    // there is no taskbar entry inviting a click.
    stopAssertingLock();
    globalShortcut.unregisterAll();
    win.setAlwaysOnTop(false);
    // Maintenance hands the machine to staff, so the lock screen gets out of
    // the way completely. A player's session shows the launcher instead,
    // because that is where they start a game and watch their time.
    revealDesktop({ toDesktop: Boolean(opts.maintenance) });
    // The staff escape stays registered while unlocked too, so a member of
    // staff can always take a PC back for maintenance.
    registerStaffEscape();
  }

  win.webContents.send("seika:state", { locked, reason: reason ?? null });
}

// ─── Server connection ───────────────────────────────────────────────────────

function connectRealtime() {
  socket = io(config.wsUrl, {
    transports: ["websocket", "polling"],
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 10_000,
  });

  const join = () => {
    socket.emit("join:pc", { pcId: config.pcId, clientKey: config.clientKey });
    lastConnected = true;
    send("seika:connection", { connected: true });
  };

  socket.on("connect", join);
  socket.io.on("reconnect", join);
  socket.on("disconnect", () => {
    lastConnected = false;
    send("seika:connection", { connected: false });
  });

  socket.on("error:auth", (payload) => {
    // A wrong clientKey means this PC is not who it claims to be. Stay locked
    // and say so on screen — silently retrying hides a misconfigured install.
    applyLock(true, "This PC is not paired with the zone. Ask staff to re-pair it.");
    send("seika:fatal", { message: payload?.message ?? "PC authentication failed" });
  });

  /** The only message that may unlock this machine. */
  socket.on("command", (payload) => {
    const action = payload?.action;
    if (action === "unlock") {
      lastSession = {
        sessionId: payload?.sessionId ?? null,
        startedAt: payload?.startedAt ?? null,
        endsAt: payload?.endsAt ?? null,
        sessionMode: payload?.sessionMode ?? "OPEN_HOUR",
        games: Object.keys(allGamePaths()),
      };
      send("seika:launcher", lastSession);
      // Fetched after the UI is told to draw, so the launcher appears at once
      // and the dashboard fills in rather than holding everything up.
      void handoffForSeatedPlayer();
    }
    if (action === "lock" || action === "maintenance") {
      lastSession = null;
      send("seika:dashboard", { url: null });
    }
    switch (action) {
      case "unlock":
        applyLock(false, "Session authorized");
        break;
      case "lock":
        applyLock(true, "Session ended");
        break;
      case "restart":
        app.relaunch();
        app.exit(0);
        break;
      case "shutdown":
        app.exit(0);
        break;
      case "maintenance":
        applyLock(true, "This PC is under maintenance");
        break;
      default:
        // An unknown command is not a reason to change state.
        break;
    }
  });

  socket.on("session:update", (payload) => send("seika:session", payload));
  socket.on("order:status", (payload) => send("seika:order", payload));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * The heartbeat. Its absence is what tells the dashboard a PC is offline, so it
 * keeps running whether or not the socket is connected — the two fail
 * independently.
 */
function startHeartbeat() {
  const beat = async () => {
    try {
      await api.heartbeat();
      lastHeartbeatOk = true;
      send("seika:heartbeat", { ok: true, at: Date.now() });
      // Connectivity is back: anything the escape owed the server goes now.
      await flushEscapeReports();
    } catch (err) {
      lastHeartbeatOk = false;
      send("seika:heartbeat", { ok: false, error: err.message });
    }
  };
  void beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
}

/**
 * Keeps a current QR on screen.
 *
 * The code is rendered locally rather than fetched from an image service: a
 * zone's network can be down while its LAN is fine, and a PC id should not be
 * sent to a third party to be drawn.
 */
let refreshQrNow = async () => {};

function startQrLoop() {
  const refresh = async () => {
    try {
      const { token, expiresInSeconds, pairCode } = await api.qrToken(config.staffToken);

      // The QR holds a LINK, not the bare token. A phone's own camera then
      // works as the scanner: point, tap the notification, and the player app
      // opens already attached to this PC. Encoding the raw token meant the
      // only way in was typing a JWT off the screen, which nobody can do — so
      // in practice there was no way to scan at all.
      const payload = config.playerUrl
        ? `${String(config.playerUrl).replace(/\/$/, "")}/play/?t=${encodeURIComponent(token)}`
        : token;

      const dataUrl = await QRCode.toDataURL(payload, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
        color: { dark: "#0a0c12", light: "#ffffff" },
      });
      lastQr = { dataUrl, token, expiresInSeconds, pairCode };
      send("seika:qr", lastQr);
    } catch (err) {
      send("seika:qr", { error: err.message });
    }
  };
  refreshQrNow = refresh; // so a reloaded page can pull a fresh code at once
  void refresh();
  qrTimer = setInterval(refresh, QR_REFRESH_MS);
}

// ─── Staff escape ────────────────────────────────────────────────────────────

/**
 * A local way for staff to take a PC back.
 *
 * This is a backdoor, deliberately. Without one, a zone whose network drops has
 * every PC locked with no way in — the kiosk cannot ask the server for
 * permission precisely when it most needs to. That failure mode is worse than
 * the risk this creates, as long as the risk is bounded:
 *
 *   * The code is set per zone in config.js, never shipped in the build.
 *   * Only its hash is kept in memory; the plain code is compared and dropped.
 *   * Every use is reported to the server — immediately when online, and on the
 *     next successful heartbeat when it was used during an outage. Staff cannot
 *     use it quietly.
 *   * It unlocks for maintenance. It does not start a session, bill anyone, or
 *     award XP, so it cannot be used to hand out free play that looks paid.
 *
 * Rotate it when staff leave. The README says so in as many words.
 */
const ESCAPE_ACCELERATOR = "Control+Alt+Shift+U";

/** Uses that happened while offline and still owe the server a report. */
let pendingEscapeReports = [];

function hashCode(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

/**
 * In recovery mode the escape shortcut needs no code, because the code lives
 * in the file that is missing. It is paired with a visible button on screen:
 * a shortcut nobody knows about is not a way out.
 */
function registerRecoveryEscape() {
  try {
    globalShortcut.register(ESCAPE_ACCELERATOR, () => emergencyExit("shortcut"));
  } catch {
    // The on-screen button is the one that has to work.
  }
}

/** How long staff get before the watchdog starts the kiosk again. */
const MAINTENANCE_MINUTES = 30;

/**
 * Tells the watchdog to leave the machine alone for a while.
 *
 * Staff who entered the escape code want the PC — to fix something, or to
 * uninstall. Quitting without this would be pointless: the watchdog runs
 * every minute and would put the kiosk straight back, and an uninstaller
 * cannot remove a program that keeps restarting.
 *
 * The window carries its own expiry so a PC cannot be left unguarded by
 * someone who walked away, and so a zone does not need a second ritual to
 * put it back.
 */
function openMaintenanceWindow() {
  try {
    const dir =
      process.platform === "win32"
        ? path.join(process.env.ProgramData || "C:\\ProgramData", "SEIKA")
        : (config?.__source ? path.dirname(config.__source) : __dirname);
    fs.mkdirSync(dir, { recursive: true });
    const until = new Date(Date.now() + MAINTENANCE_MINUTES * 60_000).toISOString();
    fs.writeFileSync(path.join(dir, "maintenance.json"), JSON.stringify({ until }, null, 2));
    logger(`maintenance window open until ${until}`);
  } catch (err) {
    // Worth saying, not worth refusing the escape over: staff still get the
    // desktop, they just may have to race the watchdog.
    logger(`could not open a maintenance window: ${err.message}`);
  }
}

/** Closes the kiosk for real, so the machine can be serviced or uninstalled. */
/**
 * Is this account running SEIKA instead of explorer.exe?
 *
 * Asked rather than assumed: the installer's -KioskShell is optional, and a
 * PC set up without it already has a desktop running.
 */
function isWindowsShell() {
  if (process.platform !== "win32") return false;
  try {
    const out = require("node:child_process").execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v Shell',
      { encoding: "utf8", windowsHide: true, timeout: 4000 }
    );
    return /seika/i.test(out);
  } catch {
    // No value set means the machine default — explorer — is running.
    return false;
  }
}

/**
 * Hands the machine back, completely, the moment the code is accepted.
 *
 * With -KioskShell there is no desktop behind the kiosk: SEIKA *is* the
 * shell. Quitting without starting Explorer would leave staff looking at a
 * black screen with no taskbar and nothing to click — worse than the lock
 * they were trying to get past.
 *
 * So Explorer comes up first and the kiosk goes second, in that order.
 */
function quitForMaintenance() {
  exiting = true;
  locked = false;
  stopAssertingLock();
  globalShortcut.unregisterAll();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (qrTimer) clearInterval(qrTimer);
  try {
    socket?.disconnect();
  } catch {}

  if (isWindowsShell()) {
    try {
      // Detached, so it outlives the process that is about to end.
      spawn("explorer.exe", [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
      logger("started explorer for maintenance");
    } catch (err) {
      logger(`could not start explorer: ${err.message}`);
    }
  }

  if (win && !win.isDestroyed()) {
    win.setKiosk(false);
    win.setAlwaysOnTop(false);
    win.destroy();
  }
  app.quit();
}

/** Shuts the kiosk down. Refused unless this PC is genuinely unconfigured. */
function emergencyExit(via) {
  if (!recoveryMode) return { ok: false, reason: "Only available on an unconfigured PC" };
  logger(`emergency exit via ${via}`);
  exiting = true;
  locked = false;
  stopAssertingLock();
  globalShortcut.unregisterAll();
  if (win && !win.isDestroyed()) {
    win.setKiosk(false);
    win.setAlwaysOnTop(false);
    win.destroy();
  }
  app.quit();
  return { ok: true };
}

function registerStaffEscape() {
  if (!config?.staffEscapeCodeHash && !config?.staffEscapeCode) return;
  try {
    globalShortcut.register(ESCAPE_ACCELERATOR, () => {
      send("seika:escape-prompt", {});
      // The prompt only matters if the player can see it.
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
    });
  } catch {
    // If the accelerator cannot be registered the PC is still operable from
    // the console; this is a convenience, not the only route.
  }
}

/** Checks a code typed on the lock screen and unlocks if it matches. */
function attemptStaffEscape(code) {
  const expected = config?.staffEscapeCodeHash ?? (config?.staffEscapeCode ? hashCode(config.staffEscapeCode) : null);
  if (!expected) return { ok: false, reason: "No staff code is configured on this PC" };

  const supplied = hashCode(String(code ?? "").trim());
  // Constant-time compare: the codes are short, and a timing oracle on a
  // machine a player is sitting at is not a theoretical concern.
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!matches) {
    logger("staff escape rejected");
    return { ok: false, reason: "That code is not right" };
  }

  reportEscape({ at: new Date().toISOString() });
  // Reported before quitting: once the process is gone there is nothing left
  // to send it with, and a staff escape that is never recorded is exactly the
  // one worth recording.
  openMaintenanceWindow();
  locked = false;
  quitForMaintenance();
  return { ok: true };
}

/**
 * Tells the server the escape was used. Queued if it cannot be delivered, and
 * flushed on the next heartbeat — the point of the audit trail is that it
 * survives the outage that made the escape necessary.
 */
/** Where unsent escape reports wait out a restart. */
function escapeQueueFile() {
  const dir =
    process.platform === "win32"
      ? path.join(process.env.ProgramData || "C:\\ProgramData", "SEIKA")
      : (config?.__source ? path.dirname(config.__source) : __dirname);
  return path.join(dir, "escape-queue.json");
}

function persistEscapeQueue() {
  try {
    const f = escapeQueueFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (pendingEscapeReports.length) fs.writeFileSync(f, JSON.stringify(pendingEscapeReports));
    else fs.rmSync(f, { force: true });
  } catch (err) {
    logger(`could not persist escape queue: ${err.message}`);
  }
}

function loadEscapeQueue() {
  try {
    const f = escapeQueueFile();
    if (!fs.existsSync(f)) return;
    const q = JSON.parse(fs.readFileSync(f, "utf8"));
    if (Array.isArray(q)) pendingEscapeReports = [...q, ...pendingEscapeReports];
  } catch {
    // A corrupt queue is not worth blocking startup for.
  }
}

/**
 * Records a staff escape.
 *
 * Written to disk first, then sent. The escape quits the kiosk immediately —
 * that is the point of it — so an in-flight request dies with the process. A
 * staff unlock that never reaches the audit log is exactly the one worth
 * having, so it waits on disk and goes out on the next start instead.
 */
function reportEscape(entry) {
  pendingEscapeReports.push(entry);
  persistEscapeQueue();
  void flushEscapeReports();
}

async function flushEscapeReports() {
  if (!pendingEscapeReports.length) return;
  if (!api) {
    logger(`${pendingEscapeReports.length} escape report(s) waiting — no API yet`);
    return;
  }
  const queued = [...pendingEscapeReports];
  try {
    await api.reportStaffEscape(queued);
    pendingEscapeReports = [];
    persistEscapeQueue();
    logger(`sent ${queued.length} queued escape report(s)`);
  } catch (err) {
    // Said out loud: a silent failure here is an audit trail that quietly
    // stops working, and nobody finds out until it is needed.
    logger(`escape report failed, will retry: ${err.message}`);
    // Keep them. The next heartbeat tries again.
  }
}

function logger(message) {
  // The kiosk has no log file of its own by design — a player sitting at the
  // machine should not be able to read one. This goes to stdout, which the
  // watchdog's parent captures.
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: message }));
}

// ─── Smart Sync, driven by the renderer once a player is seated ──────────────

/**
 * Restores a player's settings before they play (plan K2).
 *
 * The order matters: ask the server what may sync, then read only that.
 */
async function syncDown(playerToken, game) {
  const root = smartsync.gameRoot(config, game);
  const stored = await api.downloadConfig(playerToken, game);
  if (!stored.config?.exists || !stored.config.payload) {
    return { restored: 0, version: stored.config?.version ?? 0 };
  }

  const bundle = JSON.parse(stored.config.payload);
  const paths = Object.keys(bundle.files ?? {});
  if (!paths.length) return { restored: 0, version: stored.config.version };

  // Re-screen on the way in: a bundle stored under an older policy must not
  // write somewhere the current policy forbids.
  const screened = await api.screenPaths(playerToken, game, paths);
  const written = await smartsync.apply(root, bundle, screened.allowed ?? []);

  return {
    restored: written.length,
    refused: (screened.refused ?? []).length,
    version: stored.config.version,
  };
}

/** Saves the player's settings after they play (plan K3). */
async function syncUp(playerToken, game, baseVersion) {
  const root = smartsync.gameRoot(config, game);
  const candidates = await smartsync.enumerate(root);
  if (!candidates.length) return { uploaded: 0 };

  const screened = await api.screenPaths(playerToken, game, candidates);
  const allowed = screened.allowed ?? [];
  if (!allowed.length) {
    return { uploaded: 0, refused: (screened.refused ?? []).length };
  }

  const { files, bytes } = await smartsync.collect(root, allowed);
  if (!Object.keys(files).length) return { uploaded: 0 };

  const res = await api.uploadConfig(playerToken, game, {
    payload: JSON.stringify({ files }),
    paths: Object.keys(files),
    baseVersion,
  });

  return {
    uploaded: Object.keys(files).length,
    bytes,
    version: res.version,
    refused: (screened.refused ?? []).length,
  };
}

function registerIpc() {
  ipcMain.handle("seika:sync-down", async (_e, { playerToken, game }) => {
    try {
      return { ok: true, ...(await syncDown(playerToken, game)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("seika:sync-up", async (_e, { playerToken, game, baseVersion }) => {
    try {
      return { ok: true, ...(await syncUp(playerToken, game, baseVersion ?? 0)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("seika:games", async (_e, { playerToken }) => {
    try {
      const res = await api.syncGames(playerToken);
      // Only offer games this machine actually has installed.
      return {
        ok: true,
        games: (res.games ?? []).filter((g) => smartsync.hasGame(config, g.game)),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("seika:staff-escape", (_e, { code }) => attemptStaffEscape(code));
  ipcMain.handle("seika:emergency-exit", () => emergencyExit("button"));
  // Refused while locked: a PC that has not been paid for does not run games.
  ipcMain.handle("seika:save-game", (_e, payload) => saveGame(payload ?? {}));
  // Staff-gated like saveGame: knowing what is installed is not secret, but
  // this is only reachable from the staff panel and keeping the gate in one
  // place is worth more than the exception.
  ipcMain.handle("seika:detect-games", async (_e, { staffToken } = {}) => {
    try {
      const who = await api?.whoAmI(staffToken);
      if (who?.auth?.typ !== "staff") return { ok: false, reason: "Staff only" };
    } catch {
      return { ok: false, reason: "That sign-in did not work" };
    }
    try {
      const games = detectGames();
      const have = new Set(Object.keys(allGamePaths()));
      return { ok: true, games: games.map((g) => ({ ...g, already: have.has(g.name) })) };
    } catch (err) {
      logger(`detect failed: ${err.message}`);
      return { ok: false, reason: "Could not read the launcher libraries" };
    }
  });

  ipcMain.handle("seika:pick-game", async () => {
    const res = await dialog.showOpenDialog(win, {
      title: "Choose the game",
      // Shortcuts included on purpose: a desktop shortcut is how most people
      // can point at a game they cannot find the exe for.
      filters:
        process.platform === "win32"
          ? [{ name: "Games and shortcuts", extensions: ["exe", "lnk", "url"] }]
          : [{ name: "Applications", extensions: ["app", ""] }],
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    const picked = res.filePaths[0];
    return {
      ok: true,
      path: picked,
      // A sensible default name, so staff usually only have to confirm it.
      name: path.basename(picked).replace(/\.(exe|lnk|url|app)$/i, ""),
    };
  });
  ipcMain.handle("seika:list-games", () => ({ ok: true, games: allGamePaths() }));
  ipcMain.handle("seika:launch-game", (_e, { name }) =>
    locked ? { ok: false, reason: "The PC is locked" } : launchGame(String(name ?? ""))
  );

  // Null-safe: in recovery mode there is no config, and a handler that threw
  // here left the renderer's getConfig() rejected — so the screen kept its
  // placeholder label and showed nothing about what was actually wrong.
  //
  // The renderer asks for this on load rather than waiting to be told, because
  // a message pushed at startup races the page and usually loses.
  ipcMain.handle("seika:config", () => ({
    pcId: config?.pcId ?? null,
    apiUrl: config?.apiUrl ?? null,
    zoneName: config?.zoneName ?? null,
    recoveryMode,
    recoveryReason,
  }));

  // The renderer may ask to lock, never to unlock: only the server unlocks.
  ipcMain.on("seika:request-lock", () => applyLock(true, "Locked by the PC"));
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  registerIpc();

  loadEscapeQueue();

  try {
    config = loadConfig();
  } catch (err) {
    // Misconfigured means locked — anything else hands out free play on a PC
    // nobody can account for. But it also means recovery mode, so the person
    // in front of it can get out and fix the config.
    recoveryMode = true;
    recoveryReason = err.message;
    createWindow();
    applyLock(true, err.message);
    registerRecoveryEscape();
    return;
  }

  api = new KioskApi(config);
  createWindow();
  applyLock(true, "Waiting for a player");
  connectRealtime();
  startHeartbeat();
  startQrLoop();
  registerStaffEscape();
});

/** A player closing the lock screen must not leave the PC open. */
app.on("window-all-closed", (e) => {
  if (exiting) return;
  e.preventDefault?.();
  if (app.isReady() && (!win || win.isDestroyed())) {
    createWindow();
    applyLock(true, "Restarted");
  }
});

app.on("will-quit", () => {
  closeRunningGames("kiosk quitting");
  stopAssertingLock();
  globalShortcut.unregisterAll();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (qrTimer) clearInterval(qrTimer);
  if (powerBlocker !== null && powerSaveBlocker.isStarted(powerBlocker)) {
    powerSaveBlocker.stop(powerBlocker);
  }
  socket?.disconnect();
});

// Exported for the unit tests, which exercise the pure parts without Electron.
module.exports = { BLOCKED_SHORTCUTS, HEARTBEAT_MS, QR_REFRESH_MS };
