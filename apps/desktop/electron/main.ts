import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  utilityProcess
} from "electron";
import { execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let serverProcess: Electron.UtilityProcess | null = null;
let serverPort: number | null = null;
let serverErrors: string[] = [];
let serverExited = false;
let isQuitting = false;

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
    PATH: userShellEnv.PATH || process.env.PATH || ""
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
      ? "Server output:\n" + serverErrors.slice(-10).join("\n")
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
    <h1>Work MI</h1>
    <p>Starting server...</p>
  </div>
</body>
</html>
`)}`;

function createWindow(url?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
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

// ---------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  console.log("[app] Starting Work MI Desktop...");
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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
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
