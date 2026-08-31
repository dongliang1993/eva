import type { Provider } from "../../../types/api";

import { getProviderPreset } from "./provider-presets";

/** 左栏供应商列表 —— 纯展示 + 选中意图,选中项由 ProviderSettings 持有。 */
export function ProviderList({
  providers,
  selectedId,
  onSelect
}: {
  readonly providers: readonly Provider[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}) {
  return (
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
              onClick={() => onSelect(provider.id)}
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
  );
}
