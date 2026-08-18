import { useState, useEffect } from "react";
import { Check } from "lucide-react";

import { useSettings } from "../hooks/use-settings";

export function GeneralSettings() {
  const { data, isLoading, saveSettings, isSaving, saveSuccess } = useSettings();

  const [model, setModel] = useState("");
  const [logLevel, setLogLevel] = useState("info");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data) {
      setModel(data.chat.defaultModel ?? "");
      setLogLevel(data.security.logLevel ?? "info");
      setDirty(false);
    }
  }, [data]);

  const handleSave = () => {
    if (!data) {
      return;
    }

    saveSettings({
      ...data,
      chat: {
        ...data.chat,
        defaultModel: model
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
    <div className="flex flex-col h-full">
      <div className="flex-1">
        <div className="rounded-xl border border-border bg-card p-6 mb-6">
          <h2 className="text-base font-semibold text-foreground mb-2">Model</h2>
          <p className="text-sm text-muted-foreground mb-4">
            The default LLM model used for chat and tool-calling tasks.
          </p>
          <input
            type="text"
            className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-ring transition-colors"
            placeholder="openai:gpt-4.1-mini"
            value={model}
            onChange={(e) => { setModel(e.target.value); setDirty(true); }}
          />
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-base font-semibold text-foreground mb-2">Log Level</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Server-side logging verbosity.
          </p>
          <select
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring transition-colors"
            value={logLevel}
            onChange={(e) => { setLogLevel(e.target.value); setDirty(true); }}
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
