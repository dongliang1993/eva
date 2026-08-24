import { useEffect, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";

import { useSettings } from "../hooks/use-settings";
import { useModels } from "../../../shared/hooks/use-models";
import { useTheme, type ThemeMode } from "../../../shared/hooks/use-theme";
import { ModelSelect } from "../../../shared/ui/model-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../shared/ui/select";
import type { ModelSummary } from "@eva/shared";

const THEME_OPTIONS: readonly {
  readonly value: ThemeMode;
  readonly label: string;
  readonly icon: typeof Sun;
}[] = [
    { value: "light", label: "浅色", icon: Sun },
    { value: "dark", label: "深色", icon: Moon },
    { value: "system", label: "跟随系统", icon: Monitor }
  ];

/** 外观:浅/深/跟随系统 三卡片,即点即存(localStorage + .dark class,无后端)。 */
function AppearanceSection() {
  const { mode, setMode } = useTheme();

  return (
    <div>
      <h2 className="mb-3 text-sm font-medium text-foreground">外观</h2>
      <div className="grid grid-cols-2 gap-3">
        {THEME_OPTIONS.slice(0, 2).map(({ value, label, icon: Icon }) => (
          <ThemeCard
            key={value}
            active={mode === value}
            label={label}
            icon={<Icon size={22} />}
            onClick={() => setMode(value)}
          />
        ))}
        <div className="col-span-2">
          <ThemeCard
            active={mode === "system"}
            label="跟随系统"
            icon={<Monitor size={22} />}
            onClick={() => setMode("system")}
          />
        </div>
      </div>
    </div>
  );
}

function ThemeCard({
  active,
  label,
  icon,
  onClick
}: {
  readonly active: boolean;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border py-5 transition-colors ${active
        ? "border-ring/60 bg-accent text-foreground"
        : "border-border bg-card text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        }`}
    >
      {icon}
      <span className="text-sm">{label}</span>
    </button>
  );
}

interface SlotFieldProps {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly options: readonly ModelSummary[];
  readonly onChange: (value: string) => void;
}

function SlotField({ label, description, value, options, onChange }: SlotFieldProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-base font-semibold text-foreground mb-1">{label}</h2>
      <p className="text-sm text-muted-foreground mb-3">{description}</p>
      <ModelSelect
        models={options}
        value={value === "" ? null : value}
        onChange={onChange}
        placeholder="不配置"
        triggerClassName="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors hover:border-ring/60 focus:border-ring"
        contentClassName="w-[var(--radix-popover-trigger-width)]"
      />
    </div>
  );
}

export function ModelSettings() {
  const { data, isLoading, saveSettings, isSaving, saveSuccess } = useSettings();
  const { data: models = [] } = useModels();

  const [toolModel, setToolModel] = useState("");
  const [logLevel, setLogLevel] = useState("info");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data) {
      setToolModel(data.models.tool ?? "");
      setLogLevel(data.security.logLevel ?? "info");
      setDirty(false);
    }
  }, [data]);

  const modelOptions = models;

  const handleSave = () => {
    if (!data) return;

    saveSettings({
      ...data,
      models: {
        ...data.models,
        ...(toolModel ? { tool: toolModel } : {})
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
        <AppearanceSection />

        {/* 主对话模型不在这里配 —— 它是 per-thread 选择(聊天框左下角的模型选择器),
            新建会话时选、聊天中可切换。放全局 settings 会造出第二个事实源。 */}
        <SlotField
          label="工具模型"
          description="在保证生成质量的前提下尽可能快的模型,用于对话标题生成、记忆相关操作等自动化任务。"
          value={toolModel}
          options={modelOptions}
          onChange={(v) => {
            setToolModel(v);
            setDirty(true);
          }}
        />

        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-base font-semibold text-foreground mb-1">Log Level</h2>
          <p className="text-sm text-muted-foreground mb-3">Server-side logging verbosity.</p>
          <Select
            value={logLevel}
            onValueChange={(v) => {
              setLogLevel(v);
              setDirty(true);
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="debug">debug</SelectItem>
              <SelectItem value="info">info</SelectItem>
              <SelectItem value="warn">warn</SelectItem>
              <SelectItem value="error">error</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-4 -mx-8 -mb-6 flex shrink-0 items-center justify-between border-t border-border bg-background px-8 py-3">
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
          {isSaving ? "保存中..." : saveSuccess && !dirty ? (<><Check size={14} /> 已保存</>) : "保存"}
        </button>
      </div>
    </div>
  );
}
