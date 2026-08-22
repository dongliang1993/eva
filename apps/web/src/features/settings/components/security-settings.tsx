import { useEffect, useState } from "react";
import { ShieldAlert, ShieldX } from "lucide-react";

import { useSettings } from "../hooks/use-settings";
import { isElectron } from "../../../shared/runtime";

/**
 * Security 设置页:查看/移除「始终允许」的 thread 作用域 policy(T31)。
 *
 * 条目是用户在审批卡片上点「始终允许」时,由 grant 路由经 buildPolicyKeys 选的精确 key
 * (如 `bash:thread:<id>:command:npm test`)。这里只做查看/移除:移除 = 把该条从
 * allowAlwaysPolicies filter 掉后随 settings 整块写回(replaceAppSettings 本就整块重写,
 * 不需要单独的 revoke 端点)。
 */

/** 把 policy key 渲染成人话:bash:thread:s-1:command:npm test → 「bash · npm test · 会话 s-1」。 */
const describePolicy = (key: string): { tool: string; detail: string; scope: string } => {
  const parts = key.split(":");
  const tool = parts[0] ?? key;
  // thread:<id> 固定在第 2 段;global 是旧白名单迁移的兜底。
  const scope = parts[1] === "thread" ? (parts[2] === "global" ? "全局(迁移)" : `会话 ${parts[2]?.slice(0, 8) ?? ""}`) : "";
  const detail =
    parts[3] === "command" ? (parts.slice(4).join(":") || "所有命令") : parts[3] === "tool" ? (parts[4] ?? "") : "所有调用";
  return { tool, detail, scope };
};

export function SecuritySettings() {
  const { data, isLoading, isSaving, saveSettings } = useSettings();

  // 自启动是桌面端 OS 级设置(Login Item),不进 app settings DB —— 仅 Electron 显示。
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  // T34 updater 状态条:downloaded 时露「重启更新」按钮。
  const [update, setUpdate] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!isElectron()) return;
    window.electronAPI!.getAutoLaunch().then(setAutoLaunch).catch(() => setAutoLaunch(null));
    const unbind = window.electronAPI!.onUpdaterStatus(setUpdate);
    // 启动时那次 updater 检查/下载的广播可能早于本页订阅(时序)——先拉 main 缓存的
    // 最近态兜底,再触发一次检查(已是最新会回 not-available,有新版会继续下)。
    window.electronAPI!.getUpdaterStatus().then((s) => {
      if (s) setUpdate(s);
    }).catch(() => {});
    window.electronAPI!.updaterCheck().catch(() => {});
    return unbind;
  }, []);

  const toggleAutoLaunch = (enabled: boolean) => {
    setAutoLaunch(enabled); // 乐观
    window.electronAPI!.setAutoLaunch(enabled).then(setAutoLaunch).catch(() => {});
  };

  if (isLoading || !data) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  const policies = data.security.allowAlwaysPolicies;

  const removePolicy = (key: string) => {
    saveSettings({
      ...data,
      security: {
        ...data.security,
        allowAlwaysPolicies: policies.filter((k) => k !== key)
      }
    });
  };

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto">
      <section>
        <h2 className="mb-1 text-base font-semibold text-foreground">Security</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          对话里点「始终允许」会把那次调用的精确 policy 记在下面,之后**同一会话里同样的
          命令**就不再弹审批(换会话/换命令仍会弹)。在这里可以查看和移除这些条目。
        </p>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldAlert size={14} />
          命中的 policy 会在审批时直接放行,并落台账(reason=policy:&lt;key&gt;)
        </div>
      </section>

      {isElectron() && autoLaunch !== null ? (
        <section>
          <h2 className="mb-1 text-base font-semibold text-foreground">桌面</h2>
          <label className="flex cursor-pointer items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
            <div>
              <div className="text-sm font-medium text-foreground">登录后自动启动</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                macOS 登录项 / Windows 启动注册表
              </div>
            </div>
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={autoLaunch}
              onChange={(e) => toggleAutoLaunch(e.target.checked)}
            />
          </label>

          {/* T34 更新状态:有事件才显示。downloaded 露「重启更新」。 */}
          {update ? (
            <div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
              <div className="text-sm text-foreground">
                {update.event === "checking" ? "检查更新中…"
                  : update.event === "available" ? `发现新版本 ${String(update.version ?? "")},下载中…`
                  : update.event === "downloading" ? `下载更新中 ${String(update.percent ?? 0)}%`
                  : update.event === "downloaded" ? `新版本 ${String(update.version ?? "")} 已就绪`
                  : update.event === "not-available" ? "已是最新"
                  : update.event === "error" ? "检查更新失败(详见日志)"
                  : null}
              </div>
              {update.event === "downloaded" ? (
                <button
                  type="button"
                  className="rounded border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-accent"
                  onClick={() => window.electronAPI!.updaterInstall()}
                >
                  重启更新
                </button>
              ) : update.event === "not-available" || update.event === "error" ? (
                <button
                  type="button"
                  className="rounded border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-accent"
                  onClick={() => window.electronAPI!.updaterCheck()}
                >
                  重新检查
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section>
        {policies.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            暂无条目。对话里对某次调用点「始终允许」后会出现在这里。
          </p>
        ) : (
          <div className="space-y-2">
            {policies.map((key) => {
              const { tool, detail, scope } = describePolicy(key);
              return (
                <div
                  key={key}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <code className="text-sm font-medium text-foreground">{tool}</code>
                      <span className="truncate font-mono text-xs text-muted-foreground">{detail}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{scope}</div>
                  </div>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent hover:text-red-500 disabled:opacity-40"
                    onClick={() => removePolicy(key)}
                    disabled={isSaving}
                    title="移除后,该调用需要重新审批"
                  >
                    <ShieldX size={12} />
                    移除
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
