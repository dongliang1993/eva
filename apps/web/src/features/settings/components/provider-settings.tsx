import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

import { useProviders } from "../hooks/use-providers";

import { ProviderForm } from "./provider-form";
import { ProviderList } from "./provider-list";

// ---------------------------------------------------------------------------
// 供应商设置页 —— 只剩「选中谁 + 左右两栏 + 通栏保存条」。
//
// 表单在 provider-form(连接测试、模型发现各自成块),列表在 provider-list。
// 保存条留在这一层是因为它要通栏贴底(-mx-8/-mb-6),而且脏态是按供应商记的。
// ---------------------------------------------------------------------------

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
        <ProviderList
          providers={providers}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card p-4">
          {selectedProvider ? (
            <ProviderForm
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
