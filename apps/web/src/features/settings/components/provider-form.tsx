import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import type {
  Provider,
  ProviderConnectionTestResult,
  ProviderModel
} from "../../../types/api";

import {
  ProviderTestButton,
  ProviderTestResult,
  useProviderConnectionTest
} from "./provider-connection-test";
import { ProviderModelDiscovery } from "./provider-model-discovery";
import { getProviderPreset } from "./provider-presets";
import { Toggle } from "./provider-toggle";

// ---------------------------------------------------------------------------
// 供应商详情表单 —— 一个供应商的全部可编辑字段与脏态。
//
// 「改了什么」只有这里知道:dirty 由本地值与服务端值逐项比出来上报给父级,
// 父级的 Save 按钮通过 saveRef 反过来触发这里的保存(footer 通栏贴底,不在表单内)。
// 连接测试与模型发现各自成块,它们的临时状态不掺进脏态。
// ---------------------------------------------------------------------------

const sortIds = (values: readonly string[]): readonly string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

export function ProviderForm({
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

  const buildRuntimeOverrides = useCallback((): Record<string, string> => {
    const overrides: Record<string, string> = {};

    if (localApiKey.trim()) {
      overrides.apiKey = localApiKey.trim();
    }

    if (localBaseURL.trim()) {
      overrides.baseURL = localBaseURL.trim();
    }

    return overrides;
  }, [localApiKey, localBaseURL]);

  const canUseRuntimeActions = provider.hasApiKey || localApiKey.trim().length > 0;

  const connectionTest = useProviderConnectionTest({
    canRun: canUseRuntimeActions,
    onTest: useCallback(
      () => onTest(provider.id, buildRuntimeOverrides()),
      [buildRuntimeOverrides, onTest, provider.id]
    )
  });

  const fetchModels = useCallback(async (): Promise<readonly ProviderModel[]> => {
    const payload = await onFetchModels(provider.id, buildRuntimeOverrides());
    setLocalAvailableModels([...payload.models]);

    return payload.models;
  }, [buildRuntimeOverrides, onFetchModels, provider.id]);

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
            <ProviderTestButton test={connectionTest} disabled={!canUseRuntimeActions} />
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
        <ProviderTestResult result={connectionTest.result} />
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

      <ProviderModelDiscovery
        availableModels={localAvailableModels}
        enabledModelIds={localEnabledModelIds}
        onToggleModel={handleToggleModel}
        onFetch={fetchModels}
        canFetch={canUseRuntimeActions}
      />
    </div>
  );
}
