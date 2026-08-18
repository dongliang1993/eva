import { useEffect, useState } from "react";
import { Check } from "lucide-react";

import { useSettings } from "../hooks/use-settings";
import { useModels } from "../../../shared/hooks/use-models";

interface SlotFieldProps {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly options: readonly { id: string; name: string }[];
  readonly onChange: (value: string) => void;
}

function SlotField({ label, description, value, options, onChange }: SlotFieldProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-base font-semibold text-foreground mb-1">{label}</h2>
      <p className="text-sm text-muted-foreground mb-3">{description}</p>
      <select
        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring transition-colors"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((model) => (
          <option key={model.id} value={model.id}>
            {model.id}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ModelSettings() {
  const { data, isLoading, saveSettings, isSaving, saveSuccess } = useSettings();
  const { data: models = [] } = useModels();

  const [chatModel, setChatModel] = useState("");
  const [toolModel, setToolModel] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [logLevel, setLogLevel] = useState("info");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data) {
      setChatModel(data.models.chat ?? "");
      setToolModel(data.models.tool ?? "");
      setEmbeddingModel(data.models.embedding ?? "");
      setLogLevel(data.security.logLevel ?? "info");
      setDirty(false);
    }
  }, [data]);

  const modelOptions = models.map((m) => ({ id: m.id, name: m.name }));

  const handleSave = () => {
    if (!data) return;

    saveSettings({
      ...data,
      models: {
        chat: chatModel,
        ...(toolModel ? { tool: toolModel } : {}),
        ...(embeddingModel ? { embedding: embeddingModel } : {})
      },
      security: {
        ...data.security,
        logLevel: logLevel as "error" | "warn" | "info" | "debug"
      }
    });
    setDirty(false);
  };

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        <SlotField
          label="Chat Model"
          description="主对话模型。所有 agent 回复都用它。"
          value={chatModel}
          options={modelOptions}
          onChange={(v) => {
            setChatModel(v);
            setDirty(true);
          }}
        />

        <SlotField
          label="Tool Model"
          description="杂务模型 —— compact 摘要、web 内容摘要。选个便宜的;留空回落 chat 模型。"
          value={toolModel}
          options={modelOptions}
          onChange={(v) => {
            setToolModel(v);
            setDirty(true);
          }}
        />

        <SlotField
          label="Embedding Model"
          description="记忆向量检索。不配置时语义检索降级为纯关键词检索(不报错)。"
          value={embeddingModel}
          options={modelOptions}
          onChange={(v) => {
            setEmbeddingModel(v);
            setDirty(true);
          }}
        />

        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-base font-semibold text-foreground mb-1">Log Level</h2>
          <p className="text-sm text-muted-foreground mb-3">Server-side logging verbosity.</p>
          <select
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring transition-colors"
            value={logLevel}
            onChange={(e) => {
              setLogLevel(e.target.value);
              setDirty(true);
            }}
          >
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </div>
      </div>

      <div className="sticky bottom-0 flex items-center justify-between border-t border-border bg-background px-0 pt-4 mt-8">
        <span className="text-xs text-muted-foreground">
          {saveSuccess && !dirty ? "All changes saved" : dirty ? "Unsaved changes" : ""}
        </span>
        <button
          type="button"
          className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${dirty
            ? "bg-primary text-primary-foreground hover:bg-primary/90"
            : "bg-secondary text-muted-foreground cursor-default"
            }`}
          onClick={handleSave}
          disabled={!dirty || isSaving}
        >
          {isSaving ? "Saving..." : saveSuccess && !dirty ? (<><Check size={14} /> Saved</>) : "Save"}
        </button>
      </div>
    </div>
  );
}