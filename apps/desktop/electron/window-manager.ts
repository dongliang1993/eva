// Window Manager:主窗的唯一 owner。
//
// mainWindow 之所以必须只有一个 owner:窗口被关/销毁后引用会变成死对象,托盘、深链、
// 全局快捷键三条路径都要「没窗就重建」—— 散在三处判断过一次就漏一次
// (历史症状:托盘一点报 "Object has been destroyed")。对外只暴露 focus/toggle/get。
import { app, BrowserWindow } from "electron";
import path from "node:path";

import { getServerPort } from "./server-supervisor";
import { readWindowState, writeWindowState } from "./window-state";

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

export const getMainWindow = (): BrowserWindow | null => mainWindow;

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

  // 销毁后置空,托盘/深链/快捷键下次走时 focusMainWindow 会重建,不再指死对象。
  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
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

// 启动序列建主窗:建完即成为本模块持有的 mainWindow。
export const createMainWindow = (url?: string): BrowserWindow => {
  mainWindow = createWindow(url);

  return mainWindow;
};

export function focusMainWindow(): void {
  // 窗口被关/销毁后 mainWindow 仍指向死对象(mac 关窗留进程,托盘常驻)——判
  // isDestroyed 并重建,否则托盘一点就 "Object has been destroyed"。
  if (!mainWindow || mainWindow.isDestroyed()) {
    const serverPort = getServerPort();

    if (!serverPort) {
      return; // server 还没起,没东西可显示
    }
    mainWindow = createWindow(`http://127.0.0.1:${serverPort}`);
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

export function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    focusMainWindow(); // 已关则重建
    return;
  }

  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    focusMainWindow();
  }
}
