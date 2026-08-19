import { ShieldAlert, ShieldX } from "lucide-react";

import { useSettings } from "../hooks/use-settings";

/**
 * Security 设置页:查看/移除「始终允许」的工具白名单(T14)。
 *
 * 白名单条目是用户在审批卡片上点「始终允许 X」时加的。这里只做移除
 * 视图;用 useSettings 读最新值 + saveSettings 落库,不改其它安全项。
 */
export function SecuritySettings() {
  const { data, isLoading, isSaving, saveSettings } = useSettings();

  if (isLoading || !data) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  const whitelist = data.security.alwaysAllowTools;

  const removeTool = (tool: string) => {
    saveSettings({
      ...data,
      security: {
        ...data.security,
        alwaysAllowTools: whitelist.filter((t) => t !== tool)
      }
    });
  };

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto">
      <section>
        <h2 className="mb-1 text-base font-semibold text-foreground">Security</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          对话里点「始终允许 X」会把该工具加入下面的白名单,之后这个工具再发起
          危险调用就不再弹审批。在这里可以查看和移除这些条目。
        </p>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldAlert size={14} />
          当前白名单里的工具会在审批时直接放行
        </div>
      </section>

      <section>
        {whitelist.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            白名单为空。对话里对某个工具点「始终允许」后会出现在这里。
          </p>
        ) : (
          <div className="space-y-2">
            {whitelist.map((tool) => (
              <div
                key={tool}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5"
              >
                <code className="min-w-0 flex-1 truncate text-sm text-foreground">{tool}</code>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent hover:text-red-500 disabled:opacity-40"
                  onClick={() => removeTool(tool)}
                  disabled={isSaving}
                  title="移出白名单,之后该工具的危险操作需要再审批"
                >
                  <ShieldX size={12} />
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}