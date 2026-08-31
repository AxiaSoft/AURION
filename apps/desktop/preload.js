const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aurionDesktop", {
  companion: true,
  platform: process.platform,
  openLogs: () => ipcRenderer.invoke("open-logs"),
  openData: () => ipcRenderer.invoke("open-data"),
  runInstaller: () => ipcRenderer.invoke("run-installer"),
  installDone: () => ipcRenderer.send("install-done"),
  onInstallerLog: (cb) => {
    ipcRenderer.on("installer-log", (_e, msg) => cb(msg));
  },
  onInstallerProgress: (cb) => {
    ipcRenderer.on("installer-progress", (_e, p) => cb(p));
  },
});
