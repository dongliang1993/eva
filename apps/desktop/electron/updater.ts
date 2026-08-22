import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Auto Updater(T34)
// 02 §9.6 骨架 + 21 §5.1 实证。完整链路以签名+公证为前提:未签名的 mac 包
// checkForUpdates 静默失败(02 §9.6 坑 1),所以 dev/未打包态直接跳过。
// ---------------------------------------------------------------------------

/** 最近一次 updater 状态(缓存,供 renderer 进设置页时主动拉——启动时的广播可能早于订阅)。 */
let lastStatus: Record<string, unknown> | null = null;

/** 广播 updater 状态给所有窗口(preload onUpdaterStatus 接收),并缓存为最近态。 */
function broadcast(payload: Record<string, unknown>): void {
  lastStatus = payload;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("updater-status", payload);
  }
}

/** renderer 进设置页时主动拉当前 updater 状态(补启动时错过的广播)。 */
export function getUpdaterStatus(): Record<string, unknown> | null {
  return lastStatus;
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
  // 当前发布走 GitHub prerelease(electron-updater 默认只认 /releases/latest,
  // 而 latest 不含 prerelease → 406)。内测期放开;转正式后改回 false 并发正式 release。
  autoUpdater.allowPrerelease = true;

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

  // 重启恢复:上次已下载完(quitAndInstall 没点成就退了)的更新,新版本不会重发
  // downloaded 事件 —— 启动时检查 pending 缓存,有就把 lastStatus 置回 downloaded,
  // 让设置页能拉到「重启更新」。
  restorePendingDownload();
}

/** 检测 ~/Library/Caches/<updater>/pending 里已下完的更新,恢复 lastStatus。 */
function restorePendingDownload(): void {
  try {
    // electron-updater 的缓存目录由 package.json name 派生(@eva/desktop → @evadesktop-updater),
    // 在 mac 的 ~/Library/Caches 下。app.getPath 无 "cache" 项,用 home 拼。写死并对齐(改名时同步)。
    const pendingDir = path.join(
      app.getPath("home"),
      "Library",
      "Caches",
      "@evadesktop-updater",
      "pending"
    );
    const infoPath = path.join(pendingDir, "update-info.json");

    if (!fs.existsSync(infoPath)) {
      return;
    }

    const info = JSON.parse(fs.readFileSync(infoPath, "utf-8")) as {
      fileName?: string;
    };
    const file = info.fileName ? path.join(pendingDir, info.fileName) : null;

    if (file && fs.existsSync(file)) {
      // 从文件名抠版本(Eva-0.2.4-arm64.zip → 0.2.4)
      const m = info.fileName!.match(/-(\d+\.\d+\.\d+)-/);
      const version = m?.[1] ?? "未知版本";
      console.log(`[updater] pending download found, restore status: ${version}`);
      broadcast({ event: "downloaded", version });
    }
  } catch (err) {
    console.warn("[updater] restore pending failed:", err);
  }
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
