import type { AppSettings } from "../../../../types/api";

// ---------------------------------------------------------------------------
// 记忆偏好 —— 总开关 + 自动检索/自动提取细项。
//
// 这一层不碰记忆数据本身,只把用户的改动原样交给 onPatch,
// 请求与错误提示都归 index.tsx。
// ---------------------------------------------------------------------------

function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <div className="pt-0.5">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${checked ? "bg-primary" : "bg-muted"
            } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          onClick={() => onChange(!checked)}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${checked ? "translate-x-4" : "translate-x-0.5"
              } mt-0.5`}
          />
        </button>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>
    </label>
  );
}

export function MemoryPreferences({
  settings,
  isSaving,
  onPatch
}: {
  readonly settings: AppSettings;
  readonly isSaving: boolean;
  readonly onPatch: (patch: Partial<AppSettings["memory"]>) => void;
}) {
  const memorySettings = settings.memory;

  return (
    <>
      {/* ── Section 0: 记忆开关 ── */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="text-base font-semibold text-foreground">记忆功能</h2>

        <div className="mt-4 space-y-5">
          <Toggle
            checked={memorySettings.enabled}
            onChange={(v) => onPatch({ enabled: v })}
            label="启用可搜索记忆"
            description="允许 agent 主动保存和搜索跨会话事实。长期记忆文件始终可用。"
            disabled={isSaving}
          />
          <Toggle
            checked={memorySettings.autoRetrieve}
            onChange={(v) => onPatch({ autoRetrieve: v })}
            label="自动检索"
            description="每轮开始前，从全局和当前工作区记忆中检索相关事实并注入上下文。"
            disabled={isSaving || !memorySettings.enabled}
          />
          <Toggle
            checked={memorySettings.autoSummarize}
            onChange={(v) => onPatch({ autoSummarize: v })}
            label="自动提取"
            description="回复成功后使用工具模型提取值得跨会话保留的事实，会产生额外模型用量。"
            disabled={isSaving || !memorySettings.enabled}
          />
          {memorySettings.autoSummarize ? (
            <label className="block pl-12">
              <span className="text-sm font-medium text-foreground">保存方式</span>
              <select
                className="mt-2 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
                value={memorySettings.autoSummarizeMode}
                disabled={isSaving}
                onChange={(event) => onPatch({
                  autoSummarizeMode: event.target.value as "review" | "automatic"
                })}
              >
                <option value="review">先审核（推荐）</option>
                <option value="automatic">高置信度自动保存</option>
              </select>
              <span className="mt-1 block text-xs text-muted-foreground">
                自动模式只直接保存置信度不低于 85% 的候选，其余仍进入审核。
              </span>
            </label>
          ) : null}
        </div>
      </div>
    </>
  );
}
