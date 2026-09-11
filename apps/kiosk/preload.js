// Safe bridge between the kiosk renderer and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("seika", {
  // renderer calls this to lock/unlock the physical PC
  setLocked: (locked) => ipcRenderer.send("seika:lock-state", Boolean(locked)),
});
