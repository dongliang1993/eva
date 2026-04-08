import { useState, useMemo, useEffect, useRef } from "react";
import { ChevronDown, Search } from "lucide-react";

import { useModels } from "../../../hooks/use-models";
import { useSettings } from "../../../hooks/use-settings";
import { Popover, PopoverTrigger, PopoverContent } from "../../ui/popover";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnabledModel {
  readonly modelId: string;
  readonly modelName: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly contextWindow?: string;
}

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SelectModelProps {
  readonly selectedModel: string | null;
  readonly onSelect: (modelId: string) => void;
}

export function SelectModel({ selectedModel, onSelect }: SelectModelProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data, saveSettings } = useSettings();
  const { data: models = [] } = useModels();

  // Restore selected model from settings on load
  const restoredRef = useRef(false);

  useEffect(() => {
    if (!data || restoredRef.current || selectedModel || models.length === 0) {
      return;
    }

    restoredRef.current = true;
    const saved = data.chat.defaultModel;
    const resolvedModelId = models.some((model) => model.id === saved)
      ? saved
      : models[0]!.id;

    onSelect(resolvedModelId);

    if (resolvedModelId !== saved) {
      saveSettings({
        ...data,
        chat: {
          ...data.chat,
          defaultModel: resolvedModelId
        }
      });
    }
  }, [data, models, onSelect, saveSettings, selectedModel]);

  const enabledModels: EnabledModel[] = useMemo(() => {
    return models.map((model) => ({
      modelId: model.id,
      modelName: model.name,
      providerId: model.providerId,
      providerName: model.provider,
      contextWindow: formatContextWindow(model.capabilities?.contextWindow)
    }));
  }, [models]);

  const filtered = useMemo(() => {
    if (!search) return enabledModels;
    const lower = search.toLowerCase();
    return enabledModels.filter(
      (m) =>
        m.modelName.toLowerCase().includes(lower) ||
        m.providerName.toLowerCase().includes(lower)
    );
  }, [enabledModels, search]);

  // Group by provider
  const grouped = useMemo(() => {
    const map = new Map<string, { providerName: string; models: EnabledModel[] }>();
    for (const m of filtered) {
      const existing = map.get(m.providerId);
      if (existing) {
        existing.models.push(m);
      } else {
        map.set(m.providerId, {
          providerName: m.providerName,
          models: [m]
        });
      }
    }
    return [...map.values()];
  }, [filtered]);

  const selectedDisplay = enabledModels.find((m) => m.modelId === selectedModel);
  const hasModels = enabledModels.length > 0;

  const handleSelect = (model: EnabledModel) => {
    onSelect(model.modelId);
    setOpen(false);
    setSearch("");

    // Persist to settings
    if (!data) {
      return;
    }

    saveSettings({
      ...data,
      chat: {
        ...data.chat,
        defaultModel: model.modelId
      }
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent transition-colors"
        >
          <span className={hasModels ? "text-foreground" : "text-muted-foreground"}>
            {selectedDisplay ? selectedDisplay.modelName : "Select model"}
          </span>
          <ChevronDown className="mt-[2px]" size={12} />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-0" side="top" align="start">
        {/* Search */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search size={14} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            className="flex-1 bg-transparent text-sm text-foreground placeholder-muted-foreground outline-none"
            placeholder="Search models..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>

        {/* Model list */}
        <div className="max-h-72 overflow-y-auto py-1">
          {grouped.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {hasModels
                ? "No models match your search"
                : "No models configured. Go to Settings > Providers to enable models."}
            </p>
          ) : (
            grouped.map((group) => (
              <div key={group.providerName}>
                {/* Provider header */}
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {group.providerName}
                  </span>
                </div>

                {/* Models */}
                {group.models.map((model) => (
                  <button
                    key={model.modelId}
                    type="button"
                    className={`flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors ${model.modelId === selectedModel
                      ? "bg-accent"
                      : "hover:bg-accent/50"
                      }`}
                    onClick={() => handleSelect(model)}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {model.modelName}
                      </div>
                      {model.contextWindow ? (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {model.contextWindow}
                        </div>
                      ) : null}
                    </div>
                    <span className="text-xs text-muted-foreground/50 font-mono shrink-0 ml-2">
                      {model.modelId}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
