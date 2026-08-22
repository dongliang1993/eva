import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";

// ---------------------------------------------------------------------------
// Auto Updater(T34)
// 02 §9.6 骨架 + 21 §5.1 实证。完整链路以签名+公证为前提:未签名的 mac 包
// checkForUpdates 静默失败(02 §9.6 坑 1),所以 dev/未打包态直接跳过。
// ---------------------------------------------------------------------------

/** 广播 updater 状态给所有窗口(preload onUpdaterStatus 接收)。 */
function broadcast(payload: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("updater-status", payload);
  }
}

export function initUpdater(): void {
  // dev 跳过(02 §9.2 ⑤ / §9.6):未打包没有 feed,autoUpdater 读 app.getPath 也会抛。
  if (!app.isPackaged) {
    console.log("[updater] dev/unpackaged, skipping");
    return;
  }

  autoUpdater.autoDownload = true;
  // 别在打字时自动装(15 §S11-1):下载完经 IPC 推 renderer,用户确认才 quitAndInstall。
  autoUpdater.autoInstallOnAppQuit = false;

  // 必须挂 error(02 §9.6 坑 2):网络抖动记日志别弹窗,否则未捕获异常崩主进程。
  autoUpdater.on("error", (err) => {
    console.error("[updater] error:", err.message);
    broadcast({ event: "error", message: err.message });
  });

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] checking...");
    broadcast({ event: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    console.log("[updater] available:", info.version);
    broadcast({ event: "available", version: info.version });
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[updater] up to date");
    broadcast({ event: "not-available" });
  });

  autoUpdater.on("download-progress", (p) => {
    broadcast({ event: "downloading", percent: Math.round(p.percent) });
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updater] downloaded:", info.version);
    broadcast({ event: "downloaded", version: info.version });
  });

  // 启动后查一次 + 每 4h 轮询(02 §9.6;Alma 30min,Eva 4h 够)。
  void autoUpdater.checkForUpdates().catch((err) => {
    console.warn("[updater] check failed:", err?.message ?? err);
  });

  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => {});
  }, FOUR_HOURS).unref();
}

/** 用户点「重启更新」→ quitAndInstall。 */
export function installUpdate(): void {
  autoUpdater.quitAndInstall();
}

/** renderer 手动触发检查更新。 */
export function checkForUpdates(): void {
  if (!app.isPackaged) {
    return;
  }

  void autoUpdater.checkForUpdates().catch((err) => {
    console.warn("[updater] manual check failed:", err?.message ?? err);
  });
}
