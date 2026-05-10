const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const useDevServer = process.env.DRAMA_WORDBOOK_DESKTOP_DEV === "1";
const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:4173";
const sidecarHost = "127.0.0.1";
const sidecarPort = 17321;
const sidecarBaseUrl = `http://${sidecarHost}:${sidecarPort}`;
const maxLogEntries = 800;

let sidecarProcess = null;
let sidecarStopping = false;
let healthTimer = null;
let restartTimer = null;
let sidecarStatus = {
  state: "starting",
  pid: null,
  managed: false,
  healthy: false,
  message: "Sidecar is starting",
  baseUrl: sidecarBaseUrl,
  startedAt: null,
  lastExit: null,
};
let logEntries = [];

function publishLog(entry) {
  logEntries.push(entry);
  if (logEntries.length > maxLogEntries) {
    logEntries = logEntries.slice(-maxLogEntries);
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("sidecar-log", entry);
  }
}

function addLog(level, source, message) {
  const lines = String(message)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  for (const line of lines) {
    publishLog({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      level,
      source,
      message: line,
    });
  }
}

function resolveSidecarDir() {
  if (process.env.DRAMA_WORDBOOK_SIDECAR_DIR) {
    return process.env.DRAMA_WORDBOOK_SIDECAR_DIR;
  }
  if (useDevServer) {
    return path.resolve(__dirname, "..", "..", "sidecar");
  }
  return path.join(process.resourcesPath, "sidecar");
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function resolvePythonCommand(sidecarDir) {
  if (process.env.DRAMA_WORDBOOK_PYTHON) {
    return { command: process.env.DRAMA_WORDBOOK_PYTHON, argsPrefix: [] };
  }

  const venvPython =
    process.platform === "win32"
      ? path.join(sidecarDir, ".venv", "Scripts", "python.exe")
      : path.join(sidecarDir, ".venv", "bin", "python");
  if (fileExists(venvPython)) {
    return { command: venvPython, argsPrefix: [] };
  }

  return {
    command: process.platform === "win32" ? "python" : "python3",
    argsPrefix: [],
  };
}

function resolveBundledSidecarCommand(sidecarDir) {
  const executableName = process.platform === "win32" ? "drama-wordbook-sidecar.exe" : "drama-wordbook-sidecar";
  const candidates = [
    path.join(sidecarDir, executableName),
    path.join(sidecarDir, "bin", executableName),
    path.join(sidecarDir, "dist", executableName),
  ];
  const executable = candidates.find(fileExists);
  return executable ? { command: executable, args: [] } : null;
}

function publishSidecarStatus(next) {
  sidecarStatus = { ...sidecarStatus, ...next };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("sidecar-status", sidecarStatus);
  }
}

function requestHealth(timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${sidecarBaseUrl}/health`, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ status: "ok" });
          }
          return;
        }
        reject(new Error(`health returned ${res.statusCode}`));
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("health timed out"));
    });
    req.on("error", reject);
  });
}

async function checkSidecarHealth() {
  try {
    await requestHealth();
    publishSidecarStatus({
      state: "online",
      healthy: true,
      message: sidecarProcess ? "Managed sidecar is online" : "External sidecar is online",
      managed: Boolean(sidecarProcess),
      pid: sidecarProcess?.pid || null,
    });
  } catch (error) {
    publishSidecarStatus({
      state: sidecarProcess ? "starting" : "offline",
      healthy: false,
      message: String(error?.message || error),
      managed: Boolean(sidecarProcess),
      pid: sidecarProcess?.pid || null,
    });
  }
}

function startHealthLoop() {
  if (healthTimer) return;
  healthTimer = setInterval(checkSidecarHealth, 2500);
}

function scheduleSidecarRestart(reason) {
  if (sidecarStopping || restartTimer) return;
  publishSidecarStatus({
    state: "restarting",
    healthy: false,
    message: `Restarting sidecar: ${reason}`,
  });
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startSidecar();
  }, 1500);
}

async function startSidecar() {
  if (sidecarProcess) return;

  try {
    await requestHealth(800);
    publishSidecarStatus({
      state: "online",
      healthy: true,
      managed: false,
      pid: null,
      message: "External sidecar is already running",
      startedAt: null,
    });
    return;
  } catch {
    // No existing service is listening; start our managed sidecar below.
  }

  const sidecarDir = resolveSidecarDir();
  if (!fileExists(sidecarDir)) {
    publishSidecarStatus({
      state: "error",
      healthy: false,
      managed: false,
      message: `Sidecar directory not found: ${sidecarDir}`,
    });
    return;
  }

  const bundled = resolveBundledSidecarCommand(sidecarDir);
  const python = bundled ? null : resolvePythonCommand(sidecarDir);
  const command = bundled?.command || python.command;
  const args = bundled
    ? bundled.args
    : [
        ...python.argsPrefix,
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        sidecarHost,
        "--port",
        String(sidecarPort),
      ];

  sidecarStopping = false;
  publishSidecarStatus({
    state: "starting",
    healthy: false,
    managed: true,
    pid: null,
    message: bundled
      ? `Starting bundled sidecar`
      : `Starting development sidecar with ${path.basename(python.command)}`,
    startedAt: new Date().toISOString(),
  });

  sidecarProcess = spawn(command, args, {
    cwd: sidecarDir,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      ASR_PRELOAD: process.env.ASR_PRELOAD || "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  publishSidecarStatus({
    pid: sidecarProcess.pid || null,
    message: `Sidecar process started (${sidecarProcess.pid || "pending"})`,
  });

  sidecarProcess.stdout?.on("data", (data) => {
    const text = String(data).trimEnd();
    console.log(`[sidecar] ${text}`);
    addLog("info", "sidecar", text);
  });
  sidecarProcess.stderr?.on("data", (data) => {
    const text = String(data).trimEnd();
    console.warn(`[sidecar] ${text}`);
    addLog("warn", "sidecar", text);
  });
  sidecarProcess.on("error", (error) => {
    addLog("error", "desktop", `Failed to start sidecar: ${error.message}`);
    publishSidecarStatus({
      state: "error",
      healthy: false,
      message: `Failed to start sidecar: ${error.message}`,
      pid: null,
    });
    sidecarProcess = null;
  });
  sidecarProcess.on("exit", (code, signal) => {
    const lastExit = { code, signal, at: new Date().toISOString() };
    sidecarProcess = null;
    publishSidecarStatus({
      state: sidecarStopping ? "stopped" : "offline",
      healthy: false,
      managed: false,
      pid: null,
      lastExit,
      message: sidecarStopping ? "Sidecar stopped" : `Sidecar exited (${code ?? signal})`,
    });
    addLog("warn", "desktop", sidecarStopping ? "Sidecar stopped" : `Sidecar exited (${code ?? signal})`);
    if (!sidecarStopping) {
      scheduleSidecarRestart(code ?? signal ?? "exit");
    }
  });

  setTimeout(checkSidecarHealth, 600);
}

function stopSidecar() {
  sidecarStopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (sidecarProcess) {
    sidecarProcess.kill();
    sidecarProcess = null;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 660,
    title: "Drama Wordbook",
    backgroundColor: "#f7f8fb",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (useDevServer) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  ipcMain.handle("open-external", async (_event, url) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) {
      await shell.openExternal(url);
    }
  });
  ipcMain.handle("sidecar-status", async () => sidecarStatus);
  ipcMain.handle("sidecar-logs", async () => logEntries);
  ipcMain.handle("sidecar-logs-clear", async () => {
    logEntries = [];
    return [];
  });
  ipcMain.handle("sidecar-restart", async () => {
    stopSidecar();
    sidecarStopping = false;
    await startSidecar();
    startHealthLoop();
    return sidecarStatus;
  });

  startSidecar();
  startHealthLoop();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  stopSidecar();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
