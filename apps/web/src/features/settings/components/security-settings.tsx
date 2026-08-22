import { ShieldAlert, ShieldX } from "lucide-react";

import { useSettings } from "../hooks/use-settings";

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
