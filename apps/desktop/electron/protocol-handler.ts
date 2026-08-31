// eva:// 深链。冷启动时 open-url 可能早于 ready,所以这里要缓存一次待投递的链接;
// 「什么时候能投递」由 main.ts 的启动序列决定(窗口就位后 flushPendingDeepLink)。
import { app } from "electron";
import path from "node:path";

import { focusMainWindow, getMainWindow } from "./window-manager";

// eva:// 深链投递给 renderer 跳会话。只认 eva://thread/<id>,其他形态忽略。
export function handleDeepLink(url: string): void {
  const match = url.match(/^eva:\/\/thread\/([\w-]+)/);
  if (!match) {
    console.warn(`[deep-link] Unrecognized: ${url}`);
    return;
  }

  focusMainWindow();
  getMainWindow()?.webContents.send("deep-link", url);
  console.log(`[deep-link] ${url}`);
}

// mac 深链入口。可能早于 ready(冷启动) —— preventDefault 必调,缓存到 ready 后投递。
let pendingDeepLink: string | null = null;

export const registerProtocolHandler = (): void => {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (app.isReady()) {
      handleDeepLink(url);
    } else {
      pendingDeepLink = url;
    }
  });
};

export const registerDefaultProtocolClient = (): void => {
  // dev 下 electron-builder 的 protocols 不生效,得显式注册;prod 由打包的 Info.plist 接管。
  // 参数形式是 electron-packager 约定:process.execPath 指当前可执行文件。
  if (!app.isPackaged && process.defaultApp) {
    app.setAsDefaultProtocolClient("eva", process.execPath, [
      path.resolve(process.argv[1] ?? "")
    ]);
  } else {
    app.setAsDefaultProtocolClient("eva");
  }
};

export const flushPendingDeepLink = (): void => {
  // 冷启动时 open-url 早于 ready,缓存的深链在窗口就位后投递。
  if (pendingDeepLink) {
    const url = pendingDeepLink;
    pendingDeepLink = null;
    // renderer 还没加载完,等 webContents 就绪再发
    getMainWindow()?.webContents.once("did-finish-load", () => handleDeepLink(url));
  }
};
