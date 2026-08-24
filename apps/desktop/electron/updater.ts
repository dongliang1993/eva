import { app, BrowserWindow, net } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import fs from "node:fs";
import path from "node:path";

import {
  downloadWithResume,
  githubReleaseAssetUrl,
  isDifferentialDownload,
  stagePendingUpdate,
  ChecksumMismatchError
} from "./updater-download";

// ---------------------------------------------------------------------------
// Auto Updater(T34 基础 + 23 篇 D1-D5 落地)
// 链路以签名+公证为前提:未签名的 mac 包 checkForUpdates 静默失败(02 §9.6 坑 1),
// 所以 dev/未打包态直接跳过。
//
// D1 autoDownload=false:下载必须用户触发(设置页点「立即下载」→ updater:download)。
// D2 节奏:启动 3s 首查 + 30min 轮询(Alma 同款)。
// D3 差量预热:启动 60s 后,若缓存缺 update.zip 就把「当前版本」zip 拉进缓存 ——
//    electron-updater 6.8.9 MacUpdater 以 cacheDir/update.zip 为差量基座
//    (CURRENT_MAC_APP_ZIP_FILE_NAME,源码实测);每次成功更新后它自己也会刷新
//    该文件,预热只为首次安装补基座。
// D4 救援层:downloadUpdate 失败时自研 Range 续传接管,stage 成 pending/ 格式后
//    再调一次 downloadUpdate 命中缓存(DownloadedUpdateHelper.getValidCachedUpdateFile)。
// D5 incremental 启发式:下载 total < 全量 90% 判定差量,UI 亮「增量」徽标。
// ---------------------------------------------------------------------------

const FIRST_CHECK_DELAY_MS = 3_000; // D2
const POLL_INTERVAL_MS = 30 * 60_000; // D2
const PREWARM_DELAY_MS = 60_000; // D3

// 与 electron-builder.yml publish 段对齐(23 篇 §7.3 约定耦合,改了要同步)。
const GITHUB_OWNER = "dongliang1993";
const GITHUB_REPO = "eva";

/** 最近一次 updater 状态(缓存,供 renderer 进设置页时主动拉——启动时的广播可能早于订阅)。 */
let lastStatus: Record<string, unknown> | null = null;
/** update-available 时的 UpdateInfo:救援层取 fileName/sha512/size,D5 取全量 size。 */
let lastUpdateInfo: UpdateInfo | null = null;
let lastFullSize = 0;
let downloadInFlight = false;
let checkInFlight = false;

/**
 * updater 缓存目录:由 package.json name 派生(@eva/desktop → @evadesktop-updater),
 * 在 mac 的 ~/Library/Caches 下。全模块唯一出处(23 篇 §7.6:改 name 时只动这里)。
 */
function updaterCacheDir(): string {
  return path.join(app.getPath("home"), "Library", "Caches", "@evadesktop-updater");
}

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

  // D1:不自动下载。update-available 后等用户在设置页点「立即下载」。
  autoUpdater.autoDownload = false;
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
    lastUpdateInfo = info;
    // D5:记下新版 zip 全量 size,供 incremental 启发式;files 里 url 是文件名
    // (GitHubProvider resolveFiles 在下载时才拼全 URL,事件里还是原始文件名)。
    lastFullSize = Number(pickZipFile(info)?.size ?? 0) || 0;
    broadcast({ event: "available", version: info.version });
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[updater] up to date");
    broadcast({ event: "not-available" });
  });

  autoUpdater.on("download-progress", (p) => {
    // D5:差量下载的 total 明显小于全量(Alma 同款 90% 启发式)。
    const incremental = isDifferentialDownload(p.total, lastFullSize);
    broadcast({
      event: "downloading",
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
      incremental
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updater] downloaded:", info.version);
    broadcast({ event: "downloaded", version: info.version });
  });

  // D2:启动 3s 首查(避开启动关键路径)+ 30min 轮询(Alma 同款;原来 4h 太长)。
  setTimeout(() => {
    runCheck();
  }, FIRST_CHECK_DELAY_MS).unref();

  setInterval(() => {
    runCheck();
  }, POLL_INTERVAL_MS).unref();

  // D3:预热差量基座(darwin 打包态;内部自判 update.zip 是否已存在)。
  schedulePrewarm();

  // 重启恢复:上次已下载完(quitAndInstall 没点成就退了)的更新,新版本不会重发
  // downloaded 事件 —— 启动时检查 pending 缓存,有就把 lastStatus 置回 downloaded,
  // 让设置页能拉到「重启更新」。
  restorePendingDownload();
}

/** 检查去重(Alma 同款):手动/轮询撞车时后到的直接跳过。 */
function runCheck(): void {
  if (checkInFlight) return;
  checkInFlight = true;
  void autoUpdater
    .checkForUpdates()
    .catch((err) => {
      console.warn("[updater] check failed:", err?.message ?? err);
    })
    .finally(() => {
      checkInFlight = false;
    });
}

/** 从 UpdateInfo.files 里挑当前 arch 的 zip 条目(url 字段此处是文件名)。 */
function pickZipFile(info: UpdateInfo): { url: string; sha512: string; size?: number } | null {
  const files = (info.files ?? []) as Array<{ url: string; sha512: string; size?: number }>;
  const zips = files.filter((f) => f.url.endsWith(".zip"));
  return zips.find((f) => f.url.includes(`-${process.arch}.zip`)) ?? zips[0] ?? null;
}

/** 新版 zip 的下载地址:tag 约定 `v${version}`(electron-builder 默认)。 */
function resolveAssetUrl(version: string, fileName: string): string {
  return githubReleaseAssetUrl({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    tag: `v${version}`,
    fileName
  });
}

/**
 * D1:用户点「立即下载」。失败时进 D4 救援层;救援也失败才广播 error。
 */
export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged || downloadInFlight) return;
  downloadInFlight = true;
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    console.warn("[updater] downloadUpdate failed, trying rescue:", (err as Error)?.message ?? err);
    const rescued = await rescueDownload();
    if (!rescued) {
      broadcast({ event: "error", message: "下载失败,请重试" });
    }
  } finally {
    downloadInFlight = false;
  }
}

/**
 * D4 断点续传救援层(darwin 打包态):
 * 自研 Range 下载器把新版 zip 下到 rescue-staging/(sha512 对齐 latest.yml),
 * stage 成 pending/ 格式后再调一次 downloadUpdate() —— DownloadedUpdateHelper
 * 校验 update-info.json 的 sha512 与最新 latest.yml 一致即命中缓存,
 * 直接走 update-downloaded,不再下载。
 */
async function rescueDownload(): Promise<boolean> {
  if (process.platform !== "darwin" || !lastUpdateInfo) {
    return false;
  }
  const zip = pickZipFile(lastUpdateInfo);
  if (!zip) {
    return false;
  }

  const version = lastUpdateInfo.version;
  const fileName = zip.url;
  const stagingDir = path.join(updaterCacheDir(), "rescue-staging");
  const stagedFile = path.join(stagingDir, fileName);

  try {
    console.log(`[updater] rescue downloading ${fileName} ...`);
    const { sha512 } = await downloadWithResume({
      url: resolveAssetUrl(version, fileName),
      destPath: stagedFile,
      expectedSize: zip.size,
      expectedSha512Base64: zip.sha512,
      onProgress: (p) => {
        broadcast({
          event: "downloading",
          percent: p.total ? Math.round((p.transferred / p.total) * 100) : 0,
          transferred: p.transferred,
          total: p.total,
          incremental: false,
          rescue: true
        });
      },
      log: (msg) => console.log("[updater:rescue]", msg)
    });

    stagePendingUpdate({
      pendingDir: path.join(updaterCacheDir(), "pending"),
      fileName,
      sha512,
      sourceFile: stagedFile
    });
    fs.rmSync(stagingDir, { recursive: true, force: true });

    console.log("[updater] rescue staged, re-invoking downloadUpdate (cache hit expected)");
    await autoUpdater.downloadUpdate(); // 命中 pending 缓存 → update-downloaded
    return true;
  } catch (err) {
    // sha512 对不上:pending 里可能已有脏数据,清掉让用户重试时走全量(23 篇 §4 D4)。
    if (err instanceof ChecksumMismatchError) {
      console.warn("[updater] rescue checksum mismatch, clearing pending:", err.message);
      fs.rmSync(path.join(updaterCacheDir(), "pending"), { recursive: true, force: true });
    } else {
      console.warn("[updater] rescue failed:", (err as Error)?.message ?? err);
    }
    return false;
  }
}

/**
 * D3 差量预热:electron-updater 以 cacheDir/update.zip 为差量基座,首次安装没有它
 * → 启动 60s 后闲时把「当前已装版本」的 zip 拉进去,下次更新即可差量。
 * 纯优化:任何失败都静默,下版本发布后再试(23 篇 §7.5)。
 */
function schedulePrewarm(): void {
  if (process.platform !== "darwin") return;
  setTimeout(() => {
    void prewarmCurrentZip().catch((err) => {
      console.log("[updater] prewarm skipped:", (err as Error)?.message ?? err);
    });
  }, PREWARM_DELAY_MS).unref();
}

async function prewarmCurrentZip(): Promise<void> {
  if (!net.isOnline()) return;
  const target = path.join(updaterCacheDir(), "update.zip");
  if (fs.existsSync(target)) return;

  const version = app.getVersion();
  // artifactName 约定:${productName}-${version}-${arch}.zip(electron-builder.yml:47)。
  const fileName = `${app.getName()}-${version}-${process.arch}.zip`;
  console.log(`[updater] prewarming current zip for differential: ${fileName}`);
  await downloadWithResume({
    url: resolveAssetUrl(version, fileName),
    destPath: target,
    log: (msg) => console.log("[updater:prewarm]", msg)
  });
  console.log("[updater] prewarm done — next update will be differential");
}

/** 检测缓存 pending 里已下完的更新,恢复 lastStatus。 */
function restorePendingDownload(): void {
  try {
    const pendingDir = path.join(updaterCacheDir(), "pending");
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
  runCheck();
}
