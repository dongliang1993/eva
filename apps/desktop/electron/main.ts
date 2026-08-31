import { app } from "electron";

import { enforceSingleInstance, registerAppLifecycle } from "./app-lifecycle";
import { registerIpcHandlers } from "./ipc-handlers";
import {
  flushPendingDeepLink,
  registerDefaultProtocolClient,
  registerProtocolHandler
} from "./protocol-handler";
import {
  adoptExternalServer,
  prepareServer,
  startServer,
  waitForServer
} from "./server-supervisor";
import { loadUserShellEnv } from "./shell-env";
import { resolveSystemProxy } from "./system-proxy";
import { createTray, registerGlobalShortcut } from "./tray";
import { initUpdater } from "./updater";
import { createMainWindow } from "./window-manager";

const isDev = !app.isPackaged;

// ---------------------------------------------------------------------------
// 启动序列
//
// 这个文件只剩「按顺序调用」:各区块实现分别在 shell-env / system-proxy /
// server-supervisor / window-state / window-manager / ipc-handlers /
// protocol-handler / app-lifecycle / tray 里,进程级单例状态由各自模块独占。
// ---------------------------------------------------------------------------

// ready 之前就要挂好的三件事:IPC 通道、单实例锁、mac open-url 深链缓存
// (open-url 可能早于 ready,晚挂就丢事件)。
registerIpcHandlers();
enforceSingleInstance();
registerProtocolHandler();

app.whenReady().then(async () => {
  console.log("[app] Starting Eva Desktop...");
  console.log(`[app] isDev: ${isDev}`);
  console.log(`[app] platform: ${process.platform}`);

  // 1. Load user shell environment
  const shellEnv = loadUserShellEnv();

  if (isDev) {
    const devPort = Number(process.env.DEV_SERVER_PORT || 8082);
    adoptExternalServer(devPort);
    console.log(`[app] Dev mode: server on port ${devPort}, UI from Vite on port 5173`);
    // Load from Vite dev server for HMR; API calls proxy to server via Vite config
    createMainWindow(`http://localhost:5173`);
  } else {
    // Production: fork the server ourselves
    // T33:每次启动重生成 loopback token,不落盘。dev 态为空(server hook 跳过)。
    const port = await prepareServer();
    console.log(`[app] Allocated port: ${port}`);

    // Show loading window while server starts
    const win = createMainWindow();

    // Resolve system proxy
    const proxyEnv = await resolveSystemProxy();

    // Start server
    startServer(port, shellEnv, proxyEnv);

    try {
      await waitForServer(port);
      console.log("[app] Server is ready");
      win.loadURL(`http://127.0.0.1:${port}`);
    } catch (err) {
      console.error("[app] Server startup failed:", err);
      win.loadURL(
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

  registerDefaultProtocolClient();

  // 冷启动时 open-url 早于 ready,缓存的深链在窗口就位后投递。
  flushPendingDeepLink();
});

registerAppLifecycle();
