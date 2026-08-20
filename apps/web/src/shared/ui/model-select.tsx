import { useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";

import type { ModelSummary } from "@eva/shared";

import { Popover, PopoverTrigger, PopoverContent } from "./popover";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatContextWindow = (value?: number): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value >= 1_000_000) {
    return `${value / 1_000_000}M`;
  }

  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  return String(value);
};

interface ModelGroup {
  readonly providerName: string;
  readonly models: readonly ModelSummary[];
}

/** 按 provider 分组,组内保持原顺序;搜索同时匹配模型名 / provider 名 / modelId。 */
function groupModels(models: readonly ModelSummary[], search: string): ModelGroup[] {
  const lower = search.trim().toLowerCase();
  const filtered = lower === ""
    ? models
    : models.filter(
      (m) =>
        m.name.toLowerCase().includes(lower) ||
        m.provider.toLowerCase().includes(lower) ||
        m.id.toLowerCase().includes(lower)
    );

  const map = new Map<string, { providerName: string; models: ModelSummary[] }>();
  for (const m of filtered) {
    const existing = map.get(m.providerId);
    if (existing) {
      existing.models.push(m);
    } else {
      map.set(m.providerId, { providerName: m.provider, models: [m] });
    }
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// ModelSelectContent —— 搜索框 + 分组列表,受控 open 时打开自动清空搜索并聚焦
// ---------------------------------------------------------------------------

interface ModelSelectContentProps {
  readonly models: readonly ModelSummary[];
  readonly selectedId: string | null;
  readonly onSelect: (modelId: string) => void;
}

export function ModelSelectContent({ models, selectedId, onSelect }: ModelSelectContentProps) {
  const [search, setSearch] = useState("");
  const grouped = useMemo(() => groupModels(models, search), [models, search]);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-2 py-2">
        <Search size={16} className="shrink-0 text-muted-foreground" />
        <input
          type="text"
          className="flex-1 bg-transparent text-sm text-foreground placeholder-muted-foreground outline-none"
          placeholder="Search models..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
      </div>

      <div className="max-h-72 overflow-y-auto py-1">
        {grouped.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            {models.length > 0
              ? "No models match your search"
              : "No models configured. Go to Settings > Providers to enable models."}
          </p>
        ) : (
          grouped.map((group) => (
            <div key={group.providerName}>
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="text-xs font-bold text-muted-foreground">
                  {group.providerName}
                </span>
              </div>

              {group.models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors ${model.id === selectedId
                    ? "bg-accent"
                    : "hover:bg-accent/50"
                    }`}
                  onClick={() => onSelect(model.id)}
                >
                  {/* 名称保优先:不截断、可收缩,挤的是右侧 modelId */}
                  <span className="min-w-0 shrink whitespace-nowrap text-sm font-medium text-foreground">
                    {model.name}
                  </span>
                  {formatContextWindow(model.capabilities?.contextWindow) ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatContextWindow(model.capabilities?.contextWindow)}
                    </span>
                  ) : null}
                  {/* id 里的 "providerId:" 前缀和分组标题重复,剥掉
                  <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted-foreground/50">
                    {model.id.startsWith(`${model.providerId}:`)
                      ? model.id.slice(model.providerId.length + 1)
                      : model.id}
                  </span> */}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// ModelSelect —— 通用模型选择器:触发按钮 + Popover(搜索 / provider 分组)。
// 聊天框和设置页共用同一份交互,样式差异通过 triggerClassName / contentClassName 调。
// ---------------------------------------------------------------------------

interface ModelSelectProps {
  readonly models: readonly ModelSummary[];
  readonly value: string | null;
  readonly onChange: (modelId: string) => void;
  /** 没有可选项时的占位文案 */
  readonly placeholder?: string;
  readonly triggerClassName?: string;
  readonly contentClassName?: string;
  readonly side?: "top" | "bottom";
}

export function ModelSelect({
  models,
  value,
  onChange,
  placeholder = "Select model",
  triggerClassName = "",
  contentClassName = "",
  side = "bottom"
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const selected = models.find((m) => m.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={triggerClassName}>
          <span className="truncate text-foreground">{selected ? selected.name : placeholder}</span>
          <ChevronDown size={14} className="mt-[2px] shrink-0" />
        </button>
      </PopoverTrigger>

      <PopoverContent className={`w-80 p-0 ${contentClassName}`} side={side} align="start">
        <ModelSelectContent
          models={models}
          selectedId={value}
          onSelect={(id) => {
            onChange(id);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
