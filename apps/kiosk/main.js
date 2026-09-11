// SEIKA PC Client — Electron main process.
// Runs fullscreen kiosk on each gaming PC. Renderer handles QR + Socket.IO;
// main controls the actual window lock and blocks escape keys.
const { app, BrowserWindow, globalShortcut, ipcMain } = require("electron");
const path = require("node:path");

let win = null;

function createWindow() {
  win = new BrowserWindow({
    fullscreen: true,
    kiosk: true, // true kiosk mode — no window chrome, hard to escape
    alwaysOnTop: true,
    frame: false,
    closable: false,
    minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.setAlwaysOnTop(true, "screen-saver");
}

// Block common escape shortcuts. (Ctrl+Alt+Del needs a keyboard-filter driver
// or Windows Assigned Access — documented in README.)
function lockShortcuts() {
  ["Alt+Tab", "Super", "Alt+F4", "Control+W", "Control+Shift+Esc", "Meta+Tab"].forEach((k) => {
    try { globalShortcut.register(k, () => {}); } catch {}
  });
}

app.whenReady().then(() => {
  createWindow();
  lockShortcuts();

  // Renderer tells main whether the session is unlocked. When unlocked, drop
  // kiosk so the player can use the PC/games; re-lock when session ends.
  ipcMain.on("seika:lock-state", (_e, locked) => {
    if (!win) return;
    if (locked) {
      win.setKiosk(true);
      win.setAlwaysOnTop(true, "screen-saver");
      win.show();
      win.focus();
      lockShortcuts();
    } else {
      // Unlock: release kiosk + shortcuts so the desktop/games are usable.
      globalShortcut.unregisterAll();
      win.setAlwaysOnTop(false);
      win.setKiosk(false);
      win.minimize();
    }
  });
});

// Never let the kiosk be closed by the user.
app.on("window-all-closed", (e) => { e.preventDefault?.(); });
app.on("will-quit", () => globalShortcut.unregisterAll());
