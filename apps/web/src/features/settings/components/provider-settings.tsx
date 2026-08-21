import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Check,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Search,
  Trash2
} from "lucide-react";

import { useProviders } from "../hooks/use-providers";
import type {
  Provider,
  ProviderConnectionTestResult,
  ProviderModel
} from "../../../types/api";
import { getProviderPreset } from "./provider-presets";

function Toggle({
  checked,
  onChange
}: {
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors ${checked ? "bg-primary" : "bg-border"
        }`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-5" : "translate-x-0"
          }`}
      />
    </button>
  );
}

const sortIds = (values: readonly string[]): readonly string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

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

function ProviderDetail({
  provider,
  onSave,
  onTest,
  onFetchModels,
  onRevealApiKey,
  onDirtyChange,
  saveRef
}: {
  readonly provider: Provider;
  readonly onSave: (id: string, body: Record<string, unknown>) => void;
  readonly onTest: (
    id: string,
    body?: Record<string, unknown>
  ) => Promise<ProviderConnectionTestResult>;
  readonly onFetchModels: (
    id: string,
    body?: Record<string, unknown>
  ) => Promise<{ models: readonly ProviderModel[] }>;
  /** 揭示已存 key 明文:按需调用,结果只进本地 state,不进缓存。 */
  readonly onRevealApiKey: (id: string) => Promise<string>;
  /** 脏态上报:footer 提到 ProviderSettings 后,启用/文案由父级按当前选中项渲染。 */
  readonly onDirtyChange: (dirty: boolean) => void;
  /** 保存动作注册:footer 的 Save 按钮在父级,通过 ref 触发这里的本地保存。 */
  readonly saveRef: RefObject<(() => void) | null>;
}) {
  const preset = getProviderPreset(provider.id, provider.name);
  const [showKey, setShowKey] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [testingConnection, setTestingConnection] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testResult, setTestResult] = useState<ProviderConnectionTestResult | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [localApiKey, setLocalApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  /** 揭示状态:revealState="revealed" 时输入框展示服务端取回的明文;掩码态只显示占位点。 */
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);
  const [revealPending, setRevealPending] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [localBaseURL, setLocalBaseURL] = useState(provider.baseURL ?? "");
  const [localEnabled, setLocalEnabled] = useState(provider.enabled);
  const [localAvailableModels, setLocalAvailableModels] = useState<ProviderModel[]>([
    ...provider.availableModels
  ]);
  const [localEnabledModelIds, setLocalEnabledModelIds] = useState<Set<string>>(
    () => new Set(provider.models.map((model) => model.id))
  );

  const enabledModelIds = useMemo(
    () => sortIds([...localEnabledModelIds]),
    [localEnabledModelIds]
  );
  const originalEnabledModelIds = useMemo(
    () => sortIds(provider.models.map((model) => model.id)),
    [provider.models]
  );

  const dirty =
    localBaseURL !== (provider.baseURL ?? "") ||
    localEnabled !== provider.enabled ||
    clearApiKey ||
    localApiKey.trim().length > 0 ||
    JSON.stringify(localAvailableModels) !== JSON.stringify(provider.availableModels) ||
    JSON.stringify(enabledModelIds) !== JSON.stringify(originalEnabledModelIds);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();

    if (!query) {
      return localAvailableModels;
    }

    return localAvailableModels.filter((model) =>
      model.name.toLowerCase().includes(query) ||
      model.id.toLowerCase().includes(query)
    );
  }, [localAvailableModels, modelSearch]);

  const enabledFirst = useMemo(
    () =>
      [...filteredModels].sort((left, right) => {
        const leftEnabled = localEnabledModelIds.has(left.id);
        const rightEnabled = localEnabledModelIds.has(right.id);

        if (leftEnabled === rightEnabled) {
          return left.name.localeCompare(right.name);
        }

        return leftEnabled ? -1 : 1;
      }),
    [filteredModels, localEnabledModelIds]
  );

  const handleToggleModel = (modelId: string) => {
    setLocalEnabledModelIds((previous) => {
      const next = new Set(previous);

      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }

      return next;
    });
  };

  const buildRuntimeOverrides = (): Record<string, string> => {
    const overrides: Record<string, string> = {};

    if (localApiKey.trim()) {
      overrides.apiKey = localApiKey.trim();
    }

    if (localBaseURL.trim()) {
      overrides.baseURL = localBaseURL.trim();
    }

    return overrides;
  };

  const canUseRuntimeActions = provider.hasApiKey || localApiKey.trim().length > 0;

  const handleTestConnection = useCallback(async () => {
    if (!canUseRuntimeActions) {
      return;
    }

    setTestingConnection(true);
    setTestResult(null);

    try {
      const result = await onTest(provider.id, buildRuntimeOverrides());
      setTestResult(result);
    } catch (error) {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : "Failed to test provider"
      });
    } finally {
      setTestingConnection(false);
    }
  }, [canUseRuntimeActions, localApiKey, localBaseURL, onTest, provider.id]);

  const handleFetchModels = useCallback(async () => {
    if (!canUseRuntimeActions) {
      return;
    }

    setFetchingModels(true);
    setFetchError(null);

    try {
      const payload = await onFetchModels(provider.id, buildRuntimeOverrides());
      setLocalAvailableModels([...payload.models]);
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Failed to fetch models");
    } finally {
      setFetchingModels(false);
    }
  }, [canUseRuntimeActions, onFetchModels, provider.id]);

  const handleSave = () => {
    const enabledModels = localAvailableModels.filter((model) =>
      localEnabledModelIds.has(model.id)
    );

    onSave(provider.id, {
      enabled: localEnabled,
      baseURL: localBaseURL,
      ...(localApiKey.trim() ? { apiKey: localApiKey.trim() } : {}),
      ...(clearApiKey ? { clearApiKey: true } : {}),
      models: enabledModels,
      availableModels: localAvailableModels
    });
  };

  useEffect(() => {
    saveRef.current = handleSave;
    return () => {
      saveRef.current = null;
    };
  });

  /**
   * 眼睛图标:
   * - 已揭示 → 收回(清空本地明文,回到掩码)
   * - 未揭示且已存 key、用户没输入新值 → 调揭示端点取明文展示
   * - 其余(无 key / 用户正在输入新 key)→ 仅切换本地输入的可见性
   */
  const handleToggleShowKey = async () => {
    if (revealedApiKey !== null) {
      setRevealedApiKey(null);
      setRevealError(null);
      setShowKey(false);
      return;
    }

    if (provider.hasApiKey && !clearApiKey && localApiKey.trim().length === 0) {
      setRevealPending(true);
      setRevealError(null);
      try {
        const apiKey = await onRevealApiKey(provider.id);
        setRevealedApiKey(apiKey);
        setShowKey(true);
      } catch (error) {
        setRevealError(error instanceof Error ? error.message : "Failed to reveal API key");
      } finally {
        setRevealPending(false);
      }
      return;
    }

    setShowKey((previous) => !previous);
  };

  const storedKeyMessage = provider.hasApiKey && !clearApiKey && localApiKey.trim().length === 0
    ? "A key is already stored. Enter a new key only if you want to replace it."
    : preset.apiKeyHint;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto pr-1">
      <div className="mb-1 flex shrink-0 flex-col">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-foreground">{provider.name}</h2>
            {localEnabled ? (
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
                已启用
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-lg border border-input px-3 py-1.5 text-sm text-foreground hover:bg-accent transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              onClick={handleTestConnection}
              disabled={testingConnection || !canUseRuntimeActions}
            >
              <span className="inline-flex items-center gap-1.5">
                {testingConnection ? <Loader2 size={14} className="animate-spin" /> : null}
                {testingConnection ? "Testing..." : "Test"}
              </span>
            </button>
            <Toggle checked={localEnabled} onChange={setLocalEnabled} />
          </div>
        </div>
        <p className="mb-6 text-sm text-muted-foreground">{preset.description}</p>
      </div>

      <div className="mb-5 shrink-0">
        <label className="mb-1.5 block text-sm font-medium text-foreground">API Key</label>
        <div className="flex items-center gap-2">
          <input
            type={showKey ? "text" : "password"}
            className="flex-1 h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-ring transition-colors"
            placeholder={provider.hasApiKey && !clearApiKey ? "" : "sk-..."}
            value={
              revealedApiKey !== null
                ? revealedApiKey
                : provider.hasApiKey && !clearApiKey && localApiKey.trim().length === 0
                  ? "••••••••••••••••"
                  : localApiKey
            }
            onChange={(event) => {
              // 揭示态下用户开始编辑 → 退出揭示态,按"新 key"语义走
              if (revealedApiKey !== null) {
                setRevealedApiKey(null);
                setShowKey(false);
              }
              setLocalApiKey(event.target.value);
              setClearApiKey(false);
            }}
          />
          <button
            type="button"
            className="rounded-lg border border-input p-2.5 text-muted-foreground hover:bg-accent transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void handleToggleShowKey()}
            disabled={revealPending}
          >
            {revealPending ? (
              <Loader2 size={16} className="animate-spin" />
            ) : showKey ? (
              <EyeOff size={16} />
            ) : (
              <Eye size={16} />
            )}
          </button>
        </div>
        <p className="mt-1.5 text-xs text-primary">{storedKeyMessage}</p>
        {revealError ? (
          <p className="mt-1.5 text-xs text-destructive">{revealError}</p>
        ) : null}
        {testResult ? (
          <p className={`mt-1.5 text-xs ${testResult.success ? "text-success" : "text-destructive"}`}>
            {testResult.success
              ? `Connection OK${testResult.latencyMs !== undefined ? ` · ${testResult.latencyMs}ms` : ""}`
              : testResult.error ?? "Connection test failed"}
          </p>
        ) : null}
      </div>

      <div className="mb-6 shrink-0">
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          Base URL (可选)
        </label>
        <input
          type="text"
          className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-ring transition-colors"
          placeholder={preset.defaultBaseURL}
          value={localBaseURL}
          onChange={(event) => setLocalBaseURL(event.target.value)}
        />
        <p className="mt-1.5 text-xs text-muted-foreground">{preset.baseURLHint}</p>
      </div>

      <div className="min-h-0 flex-1">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-foreground">模型</label>
            <p className="mt-1 text-xs text-muted-foreground">
              {enabledModelIds.length} enabled of {localAvailableModels.length} available
            </p>
          </div>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-sm text-foreground hover:bg-accent transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleFetchModels}
            disabled={fetchingModels || !canUseRuntimeActions}
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
                        checked={localEnabledModelIds.has(model.id)}
                        onChange={() => handleToggleModel(model.id)}
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
    </div>
  );
}

export function ProviderSettings() {
  const {
    data,
    isLoading,
    updateProvider,
    testProviderAsync,
    fetchProviderModelsAsync,
    revealApiKey,
    isSaving,
    saveSuccess
  } = useProviders();
  const providers = data ?? [];
  const [selectedId, setSelectedId] = useState<string>("");
  const [dirtyByProvider, setDirtyByProvider] = useState<Record<string, boolean>>({});
  const saveRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (providers.length === 0) {
      setSelectedId("");
      return;
    }

    if (!providers.some((provider) => provider.id === selectedId)) {
      setSelectedId(providers[0]!.id);
    }
  }, [providers, selectedId]);

  const selectedProvider = providers.find((provider) => provider.id === selectedId);
  const selectedDirty = dirtyByProvider[selectedId] === true;
  const selectedSaved = saveSuccess && !selectedDirty;

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading providers...</p>;
  }

  return (
    <div className="flex flex-1 flex-col h-full min-h-0">
      <div className="flex flex-1 gap-6 min-h-0">
        <div className="w-64 shrink-0 overflow-y-auto rounded-xl border border-border bg-card p-2">
          <div className="space-y-1.5">
            {providers.map((provider) => {
              const preset = getProviderPreset(provider.id, provider.name);

              return (
                <button
                  key={provider.id}
                  type="button"
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${provider.id === selectedId
                    ? "border-primary/30 bg-primary/5 text-primary font-medium"
                    : "border-border bg-card text-foreground hover:bg-accent"
                    }`}
                  onClick={() => setSelectedId(provider.id)}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-secondary text-xs font-bold text-secondary-foreground">
                      {preset.icon}
                    </span>
                    <span>{provider.name}</span>
                  </div>
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${provider.enabled ? "bg-primary" : "bg-border"
                      }`}
                  />
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card p-4">
          {selectedProvider ? (
            <ProviderDetail
              key={selectedProvider.id}
              provider={selectedProvider}
              onSave={(id, body) => updateProvider({ id, body })}
              onTest={(id, body) => testProviderAsync({ id, body })}
              onFetchModels={(id, body) => fetchProviderModelsAsync({ id, body })}
              onRevealApiKey={revealApiKey}
              onDirtyChange={(dirty) =>
                setDirtyByProvider((previous) =>
                  previous[selectedProvider.id] === dirty
                    ? previous
                    : { ...previous, [selectedProvider.id]: dirty }
                )
              }
              saveRef={saveRef}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Select a provider</p>
          )}
        </div>
      </div>

      {/* 保存栏与上面的供应商列表/详情上下并排,同属 ProviderSettings 一列;
          -mx-8/-mb-6 抵消设置页内容区的 padding,通栏贴底 */}
      <div className="mt-4 -mx-8 -mb-6 flex shrink-0 items-center justify-between border-t border-border bg-background px-8 py-3">
        <span className="text-xs text-muted-foreground">
          {selectedSaved ? "所有更改已保存" : selectedDirty ? "未保存的更改" : ""}
        </span>
        <button
          type="button"
          className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${selectedDirty
            ? "bg-primary text-primary-foreground hover:bg-primary/90"
            : "bg-secondary text-muted-foreground cursor-default"
            }`}
          onClick={() => saveRef.current?.()}
          disabled={!selectedDirty || isSaving}
        >
          {isSaving ? (
            "Saving..."
          ) : selectedSaved ? (
            <>
              <Check size={14} />
              Saved
            </>
          ) : (
            "保存"
          )}
        </button>
      </div>
    </div>
  );
}
