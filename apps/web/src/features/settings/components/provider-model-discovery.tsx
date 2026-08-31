import { useMemo, useState } from "react";
import { Download, Loader2, Search } from "lucide-react";

import type { ProviderModel } from "../../../types/api";

import { Toggle } from "./provider-toggle";

// ---------------------------------------------------------------------------
// 模型发现 —— 「从供应商拉一份模型清单 + 勾选启用哪些」。
//
// 搜索词与拉取中/拉取失败是这一块自己的临时状态;清单与启用集合是脏态的一部分,
// 归 provider-form 持有(§6)。
// ---------------------------------------------------------------------------

const formatContextWindow = (value?: number): string | null => {
  if (value === undefined) {
    return null;
  }

  if (value >= 1_000_000) {
    return `${value / 1_000_000}M`;
  }

  if (value >= 1_000) {
    return `${value / 1_000}K`;
  }

  return String(value);
};

export function ProviderModelDiscovery({
  availableModels,
  enabledModelIds,
  onToggleModel,
  onFetch,
  canFetch
}: {
  readonly availableModels: readonly ProviderModel[];
  readonly enabledModelIds: ReadonlySet<string>;
  readonly onToggleModel: (modelId: string) => void;
  /** 拉一份最新清单;失败抛错,由这里显示。 */
  readonly onFetch: () => Promise<readonly ProviderModel[]>;
  readonly canFetch: boolean;
}) {
  const [modelSearch, setModelSearch] = useState("");
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();

    if (!query) {
      return availableModels;
    }

    return availableModels.filter((model) =>
      model.name.toLowerCase().includes(query) ||
      model.id.toLowerCase().includes(query)
    );
  }, [availableModels, modelSearch]);

  const enabledFirst = useMemo(
    () =>
      [...filteredModels].sort((left, right) => {
        const leftEnabled = enabledModelIds.has(left.id);
        const rightEnabled = enabledModelIds.has(right.id);

        if (leftEnabled === rightEnabled) {
          return left.name.localeCompare(right.name);
        }

        return leftEnabled ? -1 : 1;
      }),
    [filteredModels, enabledModelIds]
  );

  const handleFetchModels = async () => {
    if (!canFetch) {
      return;
    }

    setFetchingModels(true);
    setFetchError(null);

    try {
      await onFetch();
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Failed to fetch models");
    } finally {
      setFetchingModels(false);
    }
  };

  return (
    <div className="min-h-0 flex-1">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <label className="text-sm font-medium text-foreground">模型</label>
          <p className="mt-1 text-xs text-muted-foreground">
            {enabledModelIds.size} enabled of {availableModels.length} available
          </p>
        </div>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-sm text-foreground hover:bg-accent transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          onClick={handleFetchModels}
          disabled={fetchingModels || !canFetch}
        >
          {fetchingModels ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Download size={14} />
          )}
          <span>{fetchingModels ? "获取中..." : "获取"}</span>
        </button>
      </div>

      {fetchError ? (
        <p className="mb-3 text-xs text-destructive">{fetchError}</p>
      ) : null}

      <div className="relative mb-3">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          className="w-full h-9 rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-ring transition-colors"
          placeholder="搜索模型..."
          value={modelSearch}
          onChange={(event) => setModelSearch(event.target.value)}
        />
      </div>

      {enabledFirst.length > 0 ? (
        <div className="overflow-clip rounded-xl border border-border bg-card">
          <div className="divide-y divide-border">
            {enabledFirst.map((model) => {
              const contextWindow = formatContextWindow(model.capabilities?.contextWindow);

              return (
                <div
                  key={model.id}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {model.name}
                    </div>
                    <div className="mt-0.5 flex items-center gap-3">
                      {contextWindow ? (
                        <span className="text-xs text-muted-foreground">{contextWindow}</span>
                      ) : null}
                      <span className="truncate font-mono text-xs text-muted-foreground/60">
                        {model.id}
                      </span>
                    </div>
                  </div>
                  <div className="ml-3 flex items-center gap-2">
                    <Toggle
                      checked={enabledModelIds.has(model.id)}
                      onChange={() => onToggleModel(model.id)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="py-4 text-center text-sm text-muted-foreground">
          暂无模型。请获取模型或通过提供商更新添加。
        </p>
      )}
    </div>
  );
}
