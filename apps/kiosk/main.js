"use strict";

/**
 * SEIKA PC Client — Electron main process.
 *
 * This process owns three things the renderer must not: the physical lock, the
 * heartbeat, and the disk. The unlock decision itself is never made here — it
 * arrives from the server, which is the whole point of the product's core rule.
 */

const { app, BrowserWindow, globalShortcut, ipcMain, powerSaveBlocker } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const { io } = require("socket.io-client");
const QRCode = require("qrcode");

const { KioskApi } = require("./src/api");
const smartsync = require("./src/smartsync");

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

function createWindow() {
  win = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    alwaysOnTop: true,
    frame: false,
    closable: false,
    minimizable: false,
    skipTaskbar: true,
    backgroundColor: "#0a0c12",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The lock screen loads only local files; it has no reason to navigate.
      sandbox: true,
    },
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

/**
 * Applies the lock state.
 *
 * Locked is the resting state: if anything is unclear — no config, no network,
 * an unknown command — the PC stays locked. A kiosk that fails open is a kiosk
 * that gives away free play.
 */
function applyLock(next, reason) {
  locked = Boolean(next);
  if (!win || win.isDestroyed()) return;

  if (locked) {
    win.setKiosk(true);
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
    win.setKiosk(false);
    win.hide();
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
    send("seika:connection", { connected: true });
  };

  socket.on("connect", join);
  socket.io.on("reconnect", join);
  socket.on("disconnect", () => send("seika:connection", { connected: false }));

  socket.on("error:auth", (payload) => {
    // A wrong clientKey means this PC is not who it claims to be. Stay locked
    // and say so on screen — silently retrying hides a misconfigured install.
    applyLock(true, "This PC is not paired with the zone. Ask staff to re-pair it.");
    send("seika:fatal", { message: payload?.message ?? "PC authentication failed" });
  });

  /** The only message that may unlock this machine. */
  socket.on("command", (payload) => {
    const action = payload?.action;
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
      send("seika:heartbeat", { ok: true, at: Date.now() });
      // Connectivity is back: anything the escape owed the server goes now.
      await flushEscapeReports();
    } catch (err) {
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
function startQrLoop() {
  const refresh = async () => {
    try {
      const { token, expiresInSeconds } = await api.qrToken(config.staffToken);

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
      send("seika:qr", { dataUrl, token, expiresInSeconds });
    } catch (err) {
      send("seika:qr", { error: err.message });
    }
  };
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

  applyLock(false, "Unlocked by staff for maintenance");
  reportEscape({ at: new Date().toISOString() });
  return { ok: true };
}

/**
 * Tells the server the escape was used. Queued if it cannot be delivered, and
 * flushed on the next heartbeat — the point of the audit trail is that it
 * survives the outage that made the escape necessary.
 */
async function reportEscape(entry) {
  pendingEscapeReports.push(entry);
  await flushEscapeReports();
}

async function flushEscapeReports() {
  if (!pendingEscapeReports.length || !api) return;
  const queued = [...pendingEscapeReports];
  try {
    await api.reportStaffEscape(queued);
    pendingEscapeReports = [];
  } catch {
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
