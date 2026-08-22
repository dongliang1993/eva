import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  Tray,
  utilityProcess
} from "electron";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { checkForUpdates, initUpdater, installUpdate } from "./updater";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverProcess: Electron.UtilityProcess | null = null;
let serverPort: number | null = null;
let serverErrors: string[] = [];
let serverExited = false;
let isQuitting = false;

// loopback token(T33):每次启动重生成、不落盘。fork server 时经 env 传入,
// renderer 经 getServerInfo IPC 拿。dev(外部 server)为空 → server hook 跳过校验。
let loopbackToken: string | null = null;

// Loaded once at startup so child processes inherit the user's full env
let userShellEnv: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Shell Environment (borrowed from CodePilot)
// ---------------------------------------------------------------------------

/**
 * Read the user's full shell environment by running a login shell.
 * When Electron is launched from Dock (macOS), process.env is very limited
 * and won't include vars from .zshrc/.bashrc (e.g. API keys).
 */
function loadUserShellEnv(): Record<string, string> {
  if (process.platform === "win32") {
    return {};
  }

  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const result = execFileSync(shell, ["-ilc", "env"], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });

    const env: Record<string, string> = {};

    for (const line of result.split("\n")) {
      const idx = line.indexOf("=");

      if (idx > 0) {
        env[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }

    console.log(`[env] Loaded ${Object.keys(env).length} vars from user shell`);

    return env;
  } catch (err) {
    console.warn("[env] Failed to load user shell env:", err);

    return {};
  }
}

// ---------------------------------------------------------------------------
// System Proxy (borrowed from CodePilot)
// ---------------------------------------------------------------------------

async function resolveSystemProxy(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  try {
    const proxyList = await session.defaultSession.resolveProxy(
      "https://registry.npmjs.org"
    );

    if (!proxyList || proxyList === "DIRECT") {
      return env;
    }

    for (const entry of proxyList.split(";")) {
      const trimmed = entry.trim();

      if (!trimmed || trimmed === "DIRECT") {
        continue;
      }

      const httpMatch = trimmed.match(
        /^(?:PROXY|HTTPS)\s+([\w.-]+:\d+)$/i
      );

      if (httpMatch) {
        env.HTTP_PROXY = `http://${httpMatch[1]}`;
        env.HTTPS_PROXY = `http://${httpMatch[1]}`;
        console.log("[proxy] System proxy detected:", env.HTTPS_PROXY);

        return env;
      }

      const socksMatch = trimmed.match(/^SOCKS5?\s+([\w.-]+:\d+)$/i);

      if (socksMatch) {
        env.HTTP_PROXY = `socks5://${socksMatch[1]}`;
        env.HTTPS_PROXY = `socks5://${socksMatch[1]}`;
        console.log("[proxy] System SOCKS proxy detected:", env.HTTPS_PROXY);

        return env;
      }
    }
  } catch (err) {
    console.warn("[proxy] Failed to resolve system proxy:", err);
  }

  return env;
}

// ---------------------------------------------------------------------------
// Port Discovery
// ---------------------------------------------------------------------------

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();

      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Server Lifecycle
// ---------------------------------------------------------------------------

function getServerPath(): string {
  if (isDev) {
    // In dev, we don't fork — server runs via tsx watch externally
    throw new Error("getServerPath should not be called in dev mode");
  }

  return path.join(process.resourcesPath, "server", "dist", "index.js");
}

function getServerCwd(): string {
  return path.join(process.resourcesPath, "server");
}

function startServer(port: number, proxyEnv: Record<string, string>): Electron.UtilityProcess {
  const serverPath = getServerPath();
  const serverCwd = getServerCwd();

  console.log(`[server] Path: ${serverPath}`);
  console.log(`[server] CWD: ${serverCwd}`);

  serverErrors = [];
  serverExited = false;

  const env: Record<string, string> = {
    ...userShellEnv,
    // Inject system proxy only if user shell doesn't already set it
    ...(!userShellEnv.HTTP_PROXY && !userShellEnv.HTTPS_PROXY
      ? proxyEnv
      : {}),
    PORT: String(port),
    HOST: "127.0.0.1",
    HOME: os.homedir(),
    PATH: userShellEnv.PATH || process.env.PATH || "",
    // loopback token(T33):server 的 onRequest hook 拿它校验 x-eva-token。
    ...(loopbackToken ? { EVA_LOOPBACK_TOKEN: loopbackToken } : {})
  };

  const child = utilityProcess.fork(serverPath, [], {
    env,
    cwd: serverCwd,
    stdio: "pipe",
    serviceName: "eva-server"
  });

  child.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    console.log(`[server] ${msg}`);
    serverErrors.push(msg);
  });

  child.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    console.error(`[server:err] ${msg}`);
    serverErrors.push(msg);
  });

  child.on("exit", (code) => {
    console.log(`[server] Exited with code ${code}`);
    serverExited = true;
    serverProcess = null;
  });

  return child;
}

async function waitForServer(port: number, timeout = 30_000): Promise<void> {
  const start = Date.now();
  let lastError = "";

  while (Date.now() - start < timeout) {
    if (serverExited) {
      throw new Error(
        `Server process exited early.\n\n${serverErrors.join("\n")}`
      );
    }

    try {
      await new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const http = require("http");
        const req = http.get(
          {
            hostname: "127.0.0.1",
            port,
            path: "/v1/health",
            family: 4,
            timeout: 2000
          },
          (res: { statusCode?: number }) => {
            if (res.statusCode === 200) {
              resolve();
            } else {
              reject(new Error(`Status ${res.statusCode}`));
            }
          }
        );
        req.on("error", (err: Error) => reject(err));
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("request timeout"));
        });
      });

      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  throw new Error(
    `Server startup timeout after ${timeout / 1000}s.\nLast error: ${lastError}\n\n${serverErrors.length > 0
      ? "Server output:\n" + serverErrors.slice(-20).join("\n")
      : "No server output captured."
    }`
  );
}

function killServer(): void {
  if (!serverProcess) {
    return;
  }

  console.log("[server] Sending SIGTERM...");
  serverProcess.kill();

  // Force kill after 3s grace period
  const forceKillTimer = setTimeout(() => {
    if (serverProcess) {
      console.log("[server] Force killing...");

      try {
        if (serverProcess.pid !== undefined) {
          process.kill(serverProcess.pid, "SIGKILL");
        }
      } catch {
        // Process may have already exited
      }
    }
  }, 3000);

  serverProcess.on("exit", () => {
    clearTimeout(forceKillTimer);
  });
}

// ---------------------------------------------------------------------------
// Window State Memory
// ---------------------------------------------------------------------------

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

const DEFAULT_WINDOW_STATE: WindowState = { width: 1200, height: 800 };

function getWindowStatePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

function readWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), "utf-8");
    const s = JSON.parse(raw) as WindowState;

    // 上次的坐标可能落在已拔掉的副屏上 —— 恢复前校验还在当前某块屏内,否则丢回默认居中。
    if (typeof s.x === "number" && typeof s.y === "number") {
      const onScreen = screen.getAllDisplays().some((d) => {
        const { x, y, width, height } = d.workArea;
        return (
          s.x! >= x - 8 &&
          s.y! >= y - 8 &&
          s.x! < x + width &&
          s.y! < y + height
        );
      });

      if (!onScreen) {
        delete s.x;
        delete s.y;
      }
    }

    return { ...DEFAULT_WINDOW_STATE, ...s };
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

function writeWindowState(win: BrowserWindow): void {
  try {
    const isMaximized = win.isMaximized();
    // 最大化时 bounds 是满屏,存进去下次恢复不出正常尺寸 —— 取 normal bounds。
    const b = win.getNormalBounds();
    const state: WindowState = {
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      isMaximized
    };
    fs.mkdirSync(path.dirname(getWindowStatePath()), { recursive: true });
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state));
  } catch (err) {
    console.warn("[window-state] Failed to write:", err);
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const LOADING_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      background: #1a1a2e;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    .container { text-align: center; }
    h1 { font-size: 24px; font-weight: 300; margin-bottom: 8px; }
    p { font-size: 14px; opacity: 0.6; }
    .spinner {
      width: 32px; height: 32px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: #6366f1;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <h1>Eva</h1>
    <p>Starting server...</p>
  </div>
</body>
</html>
`)}`;

function createWindow(url?: string): BrowserWindow {
  const state = readWindowState();

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(typeof state.x === "number" && typeof state.y === "number"
      ? { x: state.x, y: state.y }
      : {}),
    minWidth: 600,
    minHeight: 400,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    },
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", vibrancy: "sidebar" }
      : { titleBarStyle: "hidden" })
  });

  if (state.isMaximized) {
    win.maximize();
  }

  console.log(`[window] Creating window with URL: ${url}`);

  // Dev: clear cache to avoid stale assets
  if (isDev) {
    win.webContents.session.clearCache();
  }

  if (url) {
    win.loadURL(url);
  } else {
    win.loadURL(LOADING_HTML);
  }

  win.once("ready-to-show", () => {
    win.show();
  });

  win.on("close", () => {
    writeWindowState(win);
  });

  // Open external links in system browser
  win.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
    if (linkUrl.startsWith("http")) {
      require("electron").shell.openExternal(linkUrl);
    }

    return { action: "deny" };
  });

  return win;
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

ipcMain.handle("get-server-port", () => serverPort);

// T33:renderer 拿 loopback token 注入 fetch/SSE 的 x-eva-token。
ipcMain.handle("get-server-info", () => ({ port: serverPort, token: loopbackToken }));

ipcMain.handle("dialog:pick-directory", async (): Promise<string | null> => {
  if (!mainWindow) {
    return null;
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "选择工作区目录"
  });

  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// 自启动(macOS LaunchAgent / Windows Run 注册表)。openAsHidden 只 mac 有效。
ipcMain.handle("auto-launch:get", () => app.getLoginItemSettings().openAtLogin);

ipcMain.handle("auto-launch:set", (_event, enabled: boolean) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return app.getLoginItemSettings().openAtLogin;
});

// T34 updater:renderer 手动检查 / 确认安装。状态经 "updater-status" 推送。
ipcMain.handle("updater:check", () => checkForUpdates());
ipcMain.handle("updater:install", () => installUpdate());

// ---------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------

function focusMainWindow(): void {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// eva:// 深链投递给 renderer 跳会话。只认 eva://thread/<id>,其他形态忽略。
function handleDeepLink(url: string): void {
  const match = url.match(/^eva:\/\/thread\/([\w-]+)/);
  if (!match) {
    console.warn(`[deep-link] Unrecognized: ${url}`);
    return;
  }

  focusMainWindow();
  mainWindow?.webContents.send("deep-link", url);
  console.log(`[deep-link] ${url}`);
}

// 第二个实例会抢同一个 ~/.eva/eva.db —— SQLite WAL 能扛并发读写,但两个实例
// 各自 fork 一份 server、各自连一套 MCP server,行为不可预测。直接拒绝第二实例,
// 把深链 argv 转给已跑的实例。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    focusMainWindow();
    // Windows/Linux 深链走 argv;mac 走 open-url,不在这里。
    const deepLink = argv.find((a) => a.startsWith("eva://"));
    if (deepLink) {
      handleDeepLink(deepLink);
    }
  });
}

// mac 深链入口。可能早于 ready(冷启动) —— preventDefault 必调,缓存到 ready 后投递。
let pendingDeepLink: string | null = null;

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (app.isReady()) {
    handleDeepLink(url);
  } else {
    pendingDeepLink = url;
  }
});

// ---------------------------------------------------------------------------
// Tray / Global Shortcut / Auto-launch (主窗创建后调用)
// ---------------------------------------------------------------------------

function toggleMainWindow(): void {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    focusMainWindow();
  }
}

function createTray(): void {
  // Template Image:mac 托盘自动适配明暗。图标源是纯色 icon.png 的 16px 缩版,
  // 有正式 logo 后替换 build/iconTemplate.png 即可。
  const iconPath = path.join(__dirname, "..", "build", "iconTemplate.png");
  let image = nativeImage.createFromPath(iconPath);

  if (image.isEmpty()) {
    // dev 时 build/ 可能不在 dist-electron 旁,退回 app 根
    image = nativeImage.createFromPath(
      path.join(app.getAppPath(), "build", "iconTemplate.png")
    );
  }

  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }

  tray = new Tray(image);
  tray.setToolTip("Eva");

  const menu = Menu.buildFromTemplate([
    { label: "显示 Eva", click: () => focusMainWindow() },
    {
      label: "设置",
      click: () => {
        focusMainWindow();
        mainWindow?.webContents.send("deep-link", "eva://settings");
      }
    },
    { type: "separator" },
    {
      label: "退出 Eva",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
  tray.on("click", () => focusMainWindow());
}

function registerGlobalShortcut(): void {
  const ok = globalShortcut.register("Alt+Space", toggleMainWindow);

  if (!ok) {
    // 被别的 app 占了 —— 降级,不致命,托盘/程序坞仍可用。
    console.warn("[shortcut] Alt+Space 注册失败(可能被占用),已跳过");
  }
}

app.whenReady().then(async () => {
  console.log("[app] Starting Eva Desktop...");
  console.log(`[app] isDev: ${isDev}`);
  console.log(`[app] platform: ${process.platform}`);

  // 1. Load user shell environment
  userShellEnv = loadUserShellEnv();

  if (isDev) {
    serverPort = Number(process.env.DEV_SERVER_PORT || 8082);
    console.log(`[app] Dev mode: server on port ${serverPort}, UI from Vite on port 5173`);
    // Load from Vite dev server for HMR; API calls proxy to server via Vite config
    mainWindow = createWindow(`http://localhost:5173`);
  } else {
    // Production: fork the server ourselves
    serverPort = await getAvailablePort();
    // T33:每次启动重生成 loopback token,不落盘。dev 态为空(server hook 跳过)。
    loopbackToken = randomBytes(24).toString("hex");
    console.log(`[app] Allocated port: ${serverPort}`);

    // Show loading window while server starts
    mainWindow = createWindow();

    // Resolve system proxy
    const proxyEnv = await resolveSystemProxy();

    // Start server
    serverProcess = startServer(serverPort, proxyEnv);

    try {
      await waitForServer(serverPort);
      console.log("[app] Server is ready");
      mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
    } catch (err) {
      console.error("[app] Server startup failed:", err);
      mainWindow.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          `<html><body style="background:#1a1a2e;color:#e0e0e0;font-family:system-ui;padding:40px">
            <h1>Server Failed to Start</h1>
            <pre>${err instanceof Error ? err.message : String(err)}</pre>
          </body></html>`
        )}`
      );
    }
  }

  // 系统集成:托盘 + 全局唤起,挂在主窗创建后(深浅链投递/快捷键都要 mainWindow)。
  createTray();
  registerGlobalShortcut();
  // T34:必须在 ready 后(autoUpdater 读 app.getPath)。dev 内 initUpdater 直接跳过。
  initUpdater();

  // dev 下 electron-builder 的 protocols 不生效,得显式注册;prod 由打包的 Info.plist 接管。
  // 参数形式是 electron-packager 约定:process.execPath 指当前可执行文件。
  if (isDev && process.defaultApp) {
    app.setAsDefaultProtocolClient("eva", process.execPath, [
      path.resolve(process.argv[1] ?? "")
    ]);
  } else {
    app.setAsDefaultProtocolClient("eva");
  }

  // 冷启动时 open-url 早于 ready,缓存的深链在窗口就位后投递。
  if (pendingDeepLink) {
    const url = pendingDeepLink;
    pendingDeepLink = null;
    // renderer 还没加载完,等 webContents 就绪再发
    mainWindow?.webContents.once("did-finish-load", () => handleDeepLink(url));
  }
});

app.on("window-all-closed", () => {
  // mac 惯例:关窗留进程(托盘可再唤起)。托盘「退出 Eva」会先置 isQuitting。
  if (process.platform !== "darwin" || isQuitting) {
    killServer();
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
    mainWindow = createWindow(`http://127.0.0.1:${serverPort}`);
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  killServer();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
