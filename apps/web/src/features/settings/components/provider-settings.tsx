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

  const storedKeyMessage = provider.hasApiKey && !clearApiKey && localApiKey.trim().length === 0
    ? "A key is already stored. Enter a new key only if you want to replace it."
    : preset.apiKeyHint;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto pr-1">
      <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-foreground">{provider.name}</h2>
            {localEnabled ? (
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
                Active
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

        <div className="mb-5">
          <label className="mb-1.5 block text-sm font-medium text-foreground">API Key</label>
          <div className="flex items-center gap-2">
            <input
              type={showKey ? "text" : "password"}
              className="flex-1 h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-ring transition-colors"
              placeholder={provider.hasApiKey && !clearApiKey ? "Stored key will be preserved" : "sk-..."}
              value={localApiKey}
              onChange={(event) => {
                setLocalApiKey(event.target.value);
                setClearApiKey(false);
              }}
            />
            <button
              type="button"
              className="rounded-lg border border-input p-2.5 text-muted-foreground hover:bg-accent transition-colors"
              onClick={() => setShowKey((previous) => !previous)}
            >
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
            {provider.hasApiKey ? (
              <button
                type="button"
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${clearApiKey
                  ? "border-destructive/30 text-destructive hover:bg-destructive/5"
                  : "border-input text-muted-foreground hover:bg-accent"
                  }`}
                onClick={() => setClearApiKey((previous) => !previous)}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Trash2 size={14} />
                  {clearApiKey ? "Will remove" : "Clear saved key"}
                </span>
              </button>
            ) : null}
          </div>
          <p className="mt-1.5 text-xs text-primary">{storedKeyMessage}</p>
          {testResult ? (
            <p className={`mt-1.5 text-xs ${testResult.success ? "text-success" : "text-destructive"}`}>
              {testResult.success
                ? `Connection OK${testResult.latencyMs !== undefined ? ` · ${testResult.latencyMs}ms` : ""}`
                : testResult.error ?? "Connection test failed"}
            </p>
          ) : null}
        </div>

        <div className="mb-6">
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Base URL (Optional)
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

        <div>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-foreground">Models</label>
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
              <span>{fetchingModels ? "Fetching..." : "Fetch"}</span>
            </button>
          </div>

          {provider.hasApiKey && localApiKey.trim().length === 0 ? (
            <p className="mb-3 text-xs text-muted-foreground">
              Stored credentials will be used by the server. Enter a new key only to test or fetch with an override.
            </p>
          ) : null}

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
              placeholder="Search models..."
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
              No models yet. Fetch models or add them through provider updates.
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

      <div className="min-w-0 min-h-0 flex-1 rounded-xl border border-border bg-card p-4">
        {selectedProvider ? (
          <ProviderDetail
            key={selectedProvider.id}
            provider={selectedProvider}
            onSave={(id, body) => updateProvider({ id, body })}
            onTest={(id, body) => testProviderAsync({ id, body })}
            onFetchModels={(id, body) => fetchProviderModelsAsync({ id, body })}
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
      <div className="mt-4 -mx-8 -mb-6 flex shrink-0 items-center justify-between border-t border-border bg-background px-8 py-4">
        <span className="text-xs text-muted-foreground">
          {selectedSaved ? "All changes saved" : selectedDirty ? "Unsaved changes" : ""}
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
            "Save"
          )}
        </button>
      </div>
    </div>
  );
}
