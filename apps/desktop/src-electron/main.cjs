const { app, BrowserWindow, Notification, ipcMain, shell } = require("electron");
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
const sharePollIntervalMs = 60_000;
const appIconPath = path.join(__dirname, "..", "resources", "icon.png");

app.setName("UNI");

let sidecarProcess = null;
let sidecarStopping = false;
let healthTimer = null;
let restartTimer = null;
let sharePollTimer = null;
let sharePollBootstrapped = false;
const seenShareEventKeys = new Set();
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

function requestJson(pathname, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${sidecarBaseUrl}${pathname}`, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`request ${pathname} failed: ${res.statusCode || "unknown"}`));
          return;
        }
        try {
          resolve(JSON.parse(body || "{}"));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${pathname} timed out`)));
    req.on("error", reject);
  });
}

function parseClockToMinute(text, fallback = 0, allow24 = false) {
  const raw = String(text || "").trim();
  if (allow24 && raw === "24:00") return 24 * 60;
  const matched = /^(\d{2}):(\d{2})$/.exec(raw);
  if (!matched) return fallback;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return hour * 60 + minute;
}

function inNotifyWindow(settings) {
  const now = new Date();
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  const start = parseClockToMinute(settings.notification_window_start, 18 * 60, false);
  const end = parseClockToMinute(settings.notification_window_end, 24 * 60, true);
  if (start === end) return true;
  if (end > start) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end;
}

function appIsInBackground() {
  const windows = BrowserWindow.getAllWindows();
  if (!windows.length) return true;
  return windows.every((win) => win.isMinimized() || !win.isVisible() || !win.isFocused());
}

async function pollShareNotifications() {
  if (!sidecarStatus.healthy) return;
  try {
    const [space, settings] = await Promise.all([
      requestJson("/space", 3500),
      requestJson("/desktop/settings", 2500),
    ]);
    const shares = Array.isArray(space?.unread_shares) ? space.unread_shares : [];
    const eventKeys = [];
    for (const share of shares) {
      const shareId = Number(share?.id || 0);
      if (shareId > 0) eventKeys.push(`share:${shareId}`);
      for (const reply of Array.isArray(share?.replies) ? share.replies : []) {
        const replyId = Number(reply?.id || 0);
        if (replyId > 0) eventKeys.push(`reply:${replyId}`);
      }
    }
    const newKeys = eventKeys.filter((key) => !seenShareEventKeys.has(key));
    for (const key of eventKeys) seenShareEventKeys.add(key);
    if (!sharePollBootstrapped) {
      sharePollBootstrapped = true;
      return;
    }
    if (!newKeys.length || !appIsInBackground() || !inNotifyWindow(settings || {})) return;
    const newShareCount = newKeys.filter((key) => key.startsWith("share:")).length;
    const newReplyCount = newKeys.filter((key) => key.startsWith("reply:")).length;
    const pieces = [];
    if (newShareCount) pieces.push(`${newShareCount} 条新分享`);
    if (newReplyCount) pieces.push(`${newReplyCount} 条新评论`);
    if (!pieces.length || !Notification.isSupported()) return;
    new Notification({
      title: "UNI",
      body: `${pieces.join("，")}，点击应用查看`,
      silent: false,
    }).show();
  } catch (error) {
    addLog("warn", "desktop", `Share poll skipped: ${String(error?.message || error)}`);
  }
}

function startSharePollLoop() {
  if (sharePollTimer) return;
  sharePollTimer = setInterval(() => {
    pollShareNotifications();
  }, sharePollIntervalMs);
  setTimeout(() => {
    pollShareNotifications();
  }, 6000);
}

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

/** PyInstaller onedir 会生成与可执行文件同名的目录；exists 为真但不能 spawn，需 isFile。 */
function isExecutableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
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
  // 开发模式默认走 venv + uvicorn；若需本地测冻结二进制：DRAMA_WORDBOOK_USE_BUNDLED_SIDECAR=1
  if (useDevServer && process.env.DRAMA_WORDBOOK_USE_BUNDLED_SIDECAR !== "1") {
    return null;
  }
  // PyInstaller onedir: 可执行文件在 dist/drama-wordbook-sidecar/drama-wordbook-sidecar（外层同名的是目录，勿 spawn）。
  // electron-builder 把 dist/drama-wordbook-sidecar/* 拷到 Resources/sidecar/，多为 sidecar/<exe> + _internal。
  const candidates = [
    path.join(sidecarDir, executableName),
    path.join(sidecarDir, "drama-wordbook-sidecar", executableName),
    path.join(sidecarDir, "dist", "drama-wordbook-sidecar", executableName),
    path.join(sidecarDir, "dist", executableName),
    path.join(sidecarDir, "bin", executableName),
  ];
  const executable = candidates.find(isExecutableFile);
  return executable ? { command: executable, args: [], cwd: path.dirname(executable) } : null;
}

function resolveSidecarDataDir() {
  const nextSidecarDataDir = path.join(app.getPath("userData"), "sidecar-data");
  const legacySidecarDataDir = path.join(app.getPath("appData"), "Drama Wordbook", "sidecar-data");
  if (fs.existsSync(legacySidecarDataDir) && !fs.existsSync(nextSidecarDataDir)) {
    return legacySidecarDataDir;
  }
  return nextSidecarDataDir;
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
  const spawnCwd = bundled?.cwd ?? sidecarDir;
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

  // Persist user data outside the app bundle so reinstalls/auto-updates do not
  // wipe the local sqlite DB and screenshots.
  const sidecarDataDir = process.env.DRAMA_WORDBOOK_DATA_DIR || resolveSidecarDataDir();
  try {
    fs.mkdirSync(sidecarDataDir, { recursive: true });
  } catch (error) {
    addLog("warn", "desktop", `Could not pre-create sidecar data dir: ${error.message}`);
  }

  sidecarProcess = spawn(command, args, {
    cwd: spawnCwd,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      ASR_PRELOAD: process.env.ASR_PRELOAD || "0",
      DRAMA_WORDBOOK_DATA_DIR: process.env.DRAMA_WORDBOOK_DATA_DIR || sidecarDataDir,
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
  if (sharePollTimer) {
    clearInterval(sharePollTimer);
    sharePollTimer = null;
  }
  if (sidecarProcess) {
    sidecarProcess.kill();
    sidecarProcess = null;
  }
}

/** GitHub Releases auto-update (electron-updater). Requires packaged build + version bump per release. Disable: DRAMA_WORDBOOK_NO_AUTO_UPDATE=1 */
function setupGithubAutoUpdater() {
  if (process.env.DRAMA_WORDBOOK_NO_AUTO_UPDATE === "1") return;
  if (!app.isPackaged || useDevServer) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (...args) => console.log("[updater]", ...args),
      warn: (...args) => console.warn("[updater]", ...args),
      error: (...args) => console.error("[updater]", ...args),
      debug: (...args) => console.debug("[updater]", ...args),
    };
    void autoUpdater.checkForUpdatesAndNotify();
    setInterval(() => {
      void autoUpdater.checkForUpdatesAndNotify();
    }, 8 * 60 * 60 * 1000);
  } catch (error) {
    console.warn("[updater] init failed:", error?.message || error);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 660,
    title: "UNI",
    icon: appIconPath,
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
    const previous = sidecarProcess;
    stopSidecar();
    if (previous) {
      await new Promise((resolve) => previous.once("exit", resolve));
    }
    sidecarStopping = false;
    await startSidecar();
    startHealthLoop();
    startSharePollLoop();
    return sidecarStatus;
  });
  ipcMain.handle("launch-at-login-get", async () => Boolean(app.getLoginItemSettings().openAtLogin));
  ipcMain.handle("launch-at-login-set", async (_event, enabled) => {
    const shouldEnable = Boolean(enabled);
    app.setLoginItemSettings({
      openAtLogin: shouldEnable,
      openAsHidden: true,
    });
    return Boolean(app.getLoginItemSettings().openAtLogin);
  });

  startSidecar();
  startHealthLoop();
  startSharePollLoop();
  createWindow();
  setupGithubAutoUpdater();

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
