"use strict";

/**
 * The bridge between the lock screen and the main process.
 *
 * Deliberately narrow. The renderer can ask for state, show a QR, and drive
 * Smart Sync for the player sitting at the PC — it cannot unlock anything and
 * cannot touch the disk directly. Unlocking is the server's decision and the
 * main process's action.
 */

const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("seika", {
  // State pushed from main.
  onState: on("seika:state"),
  onQr: on("seika:qr"),
  onHeartbeat: on("seika:heartbeat"),
  onConnection: on("seika:connection"),
  onSession: on("seika:session"),
  onOrder: on("seika:order"),
  onFatal: on("seika:fatal"),
  onEscapePrompt: on("seika:escape-prompt"),
  onLauncher: on("seika:launcher"),

  // Requests the renderer may make.
  getConfig: () => ipcRenderer.invoke("seika:config"),
  listGames: (playerToken) => ipcRenderer.invoke("seika:games", { playerToken }),
  syncDown: (playerToken, game) => ipcRenderer.invoke("seika:sync-down", { playerToken, game }),
  syncUp: (playerToken, game, baseVersion) =>
    ipcRenderer.invoke("seika:sync-up", { playerToken, game, baseVersion }),

  /**
   * Lock only. There is no plain unlock here, by design: the server unlocks.
   * The one exception is the staff escape, which takes a code and is reported
   * to the server either immediately or on the next heartbeat.
   */
  lock: () => ipcRenderer.send("seika:request-lock"),
  staffEscape: (code) => ipcRenderer.invoke("seika:staff-escape", { code }),

  /**
   * Shuts the kiosk down. Main refuses this unless the PC has no usable
   * config, where the lock is protecting nothing and the staff code cannot
   * exist because it lives in the file that is missing.
   */
  emergencyExit: () => ipcRenderer.invoke("seika:emergency-exit"),

  /**
   * Starts a game by NAME. Main maps it to a path from config.js and refuses
   * anything not listed, so the renderer can never name an executable.
   */
  launchGame: (name) => ipcRenderer.invoke("seika:launch-game", { name }),
});
