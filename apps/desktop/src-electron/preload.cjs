const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wordbookDesktop", {
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  getSidecarStatus: () => ipcRenderer.invoke("sidecar-status"),
  restartSidecar: () => ipcRenderer.invoke("sidecar-restart"),
  getSidecarLogs: () => ipcRenderer.invoke("sidecar-logs"),
  clearSidecarLogs: () => ipcRenderer.invoke("sidecar-logs-clear"),
  getLaunchAtLogin: () => ipcRenderer.invoke("launch-at-login-get"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("launch-at-login-set", Boolean(enabled)),
  onSidecarStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("sidecar-status", listener);
    return () => ipcRenderer.removeListener("sidecar-status", listener);
  },
  onSidecarLog: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on("sidecar-log", listener);
    return () => ipcRenderer.removeListener("sidecar-log", listener);
  },
  platform: process.platform,
});
