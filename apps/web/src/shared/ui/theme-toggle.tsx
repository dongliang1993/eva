import { Moon, Sun, Monitor } from "lucide-react";

import { useTheme, type ThemeMode } from "../hooks/use-theme";
import { Tooltip, TooltipProvider } from "./tooltip";

const MODE_OPTIONS: readonly { readonly value: ThemeMode; readonly label: string; readonly icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor }
];

/** 侧栏里的主题切换按钮: 点击在 light → dark → system 间循环。自带 TooltipProvider。 */
export function ThemeToggle() {
  return (
    <TooltipProvider delayDuration={300}>
      <ThemeToggleInner />
    </TooltipProvider>
  );
}

function ThemeToggleInner() {
  const { mode, setMode } = useTheme();

  const next = () => {
    const order: readonly ThemeMode[] = ["light", "dark", "system"];
    const idx = order.indexOf(mode);
    setMode(order[(idx + 1) % order.length]!);
  };

  const Icon = MODE_OPTIONS.find((o) => o.value === mode)?.icon ?? Sun;
  const label = MODE_OPTIONS.find((o) => o.value === mode)?.label ?? "浅色";

  return (
    <Tooltip content={`主题: ${label} (点击切换)`}>
      <button
        type="button"
        className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        onClick={next}
        title="切换主题"
      >
        <Icon size={18} />
      </button>
    </Tooltip>
  );
}

/** 显式三选一(浅/深/系统)的主题切换, 用于需要清晰 options 的场景。 */
export function ThemePicker() {
  const { mode, setMode } = useTheme();

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-1">
        {MODE_OPTIONS.map(({ value, label, icon: Icon }) => (
          <Tooltip key={value} content={label}>
            <button
              type="button"
              className={`rounded-md p-2 transition-colors ${
                mode === value
                  ? "text-foreground bg-accent"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
              onClick={() => setMode(value)}
              title={label}
            >
              <Icon size={18} />
            </button>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}