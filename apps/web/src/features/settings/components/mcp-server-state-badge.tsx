import type { McpConnectionState } from "../../../types/api";

const STATE_STYLE: Record<McpConnectionState, { readonly dot: string; readonly label: string }> = {
  connected: { dot: "bg-emerald-500", label: "已连接" },
  error: { dot: "bg-red-500", label: "连接失败" },
  disabled: { dot: "bg-muted-foreground/40", label: "已停用" }
};

/** 连接状态徽标 —— 颜色与文案的唯一映射。 */
export function McpServerStateBadge({ state }: { readonly state: McpConnectionState }) {
  const style = STATE_STYLE[state];

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}
