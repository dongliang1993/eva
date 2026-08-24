import { useCallback, useEffect, useState } from "react";

import { isElectron } from "../../../shared/runtime";

/**
 * 关于页:版本展示 + 软件更新(T34/D1)。
 *
 * 更新链路完全走 Electron IPC(updater.ts),浏览器里这一页没有意义 ——
 * 整个 tab 由 settings-layout 按 isElectron() 门控,这里假设已在桌面壳内。
 *
 * updater 状态条:event 驱动(available → 立即下载,downloaded → 重启更新,
 * not-available/error → 重新检查)。启动时那次广播可能早于本页订阅(时序),
 * 先拉 main 缓存的最近态兜底。
 */
export function AboutSettings() {
  const [update, setUpdate] = useState<Record<string, unknown> | null>(null);
  // 版本号走 IPC(主进程 app.getVersion()),preload 是 sandbox 拿不到 app 模块。
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    if (!isElectron()) return;
    const unbind = window.electronAPI!.onUpdaterStatus(setUpdate);
    window.electronAPI!.getUpdaterStatus()
      .then((s) => {
        if (s) setUpdate(s);
      })
      .catch(() => {});
    window.electronAPI!.getAppVersion()
      .then(setAppVersion)
      .catch(() => {});
    return unbind;
  }, []);

  const check = useCallback(() => {
    void window.electronAPI!.updaterCheck();
  }, []);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto">
      <section>
        <h2 className="mb-4 text-base font-semibold text-foreground">软件更新</h2>

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">
              检查是否有新版本,并在有更新时安装。
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              当前版本 {appVersion || "—"}
              {update?.event === "not-available" ? " · 已是最新版本" : null}
              {update?.event === "available" ? ` · 发现新版本 ${String(update.version ?? "")}` : null}
              {update?.event === "downloaded" ? ` · 新版本 ${String(update.version ?? "")} 已就绪` : null}
              {update?.event === "downloading" ? ` · 下载中 ${String(update.percent ?? 0)}%` : null}
              {update?.event === "error" ? " · 更新失败(详见日志)" : null}
            </p>
          </div>

          {/* 主操作随状态切换:available → 下载;downloaded → 重启安装;其余 → 检查更新 */}
          {update?.event === "available" ? (
            <button
              type="button"
              className="shrink-0 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
              onClick={() => window.electronAPI!.updaterDownload()}
            >
              立即下载
            </button>
          ) : update?.event === "downloaded" ? (
            <button
              type="button"
              className="shrink-0 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
              onClick={() => window.electronAPI!.updaterInstall()}
            >
              重启更新
            </button>
          ) : (
            <button
              type="button"
              className="shrink-0 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent disabled:opacity-40"
              onClick={check}
              disabled={update?.event === "checking" || update?.event === "downloading"}
            >
              {update?.event === "checking" ? "检查中…" : "检查更新"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
