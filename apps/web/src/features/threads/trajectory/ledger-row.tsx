import type { TrajectoryRow } from "./derive-trajectory";
import type { DisplayItem } from "./display-list";

const KIND_LABELS: Record<string, string> = {
  system: "System",
  user: "User",
  context: "Context",
  assistant: "Assistant",
  tool: "Tool",
  subtool: "Sub",
  compacted: "Compacted",
  error: "Error",
  raw: "Raw"
};

/** 与 DSH 单元格一致的软底 pill:system 灰 / user 蓝 / context 绿 / assistant 紫 / tool 琥珀。 */
const KIND_PILLS: Record<string, string> = {
  system: "bg-muted text-muted-foreground",
  user: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  context: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  assistant: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  tool: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  subtool: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
  compacted: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  error: "bg-destructive/15 text-destructive",
  raw: "bg-muted text-muted-foreground"
};

const formatMs = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const preview = (value: unknown, max = 72): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * 台账行(对照 DSH TrajectoryCell):左边距 Turn 角标/续行点 · kind pill ·
 * 摘要文本 · 尾部 step/时长。Tool 行内联 `name {args} → result`,错误结果标红。
 * 双击 Assistant 折叠/展开其名下的 Tool 行;行点击切换选中(检查器读它)。
 */
export function LedgerRow({
  item,
  selected,
  highlighted = false,
  onSelect,
  onToggleAssistant
}: {
  readonly item: DisplayItem & { type: "row" };
  readonly selected: boolean;
  readonly highlighted?: boolean;
  readonly onSelect: (key: string) => void;
  readonly onToggleAssistant: (key: string) => void;
}) {
  const { row, depth } = item;
  const label = KIND_LABELS[row.kind] ?? row.kind;
  const pill = KIND_PILLS[row.kind] ?? KIND_PILLS["raw"];
  const payload =
    typeof row.payload === "object" && row.payload !== null
      ? (row.payload as Record<string, unknown>)
      : {};

  return (
    <div
      role="button"
      tabIndex={0}
      className={`flex cursor-pointer items-center gap-2 border-b border-border/60 px-3 py-1 text-xs hover:bg-accent/50 ${
        selected ? "bg-accent/70" : highlighted ? "bg-amber-500/10" : ""
      }`}
      onClick={() => onSelect(row.key)}
      onDoubleClick={() => {
        if (row.kind === "assistant") onToggleAssistant(row.key);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect(row.key);
      }}
    >
      {/* 左边距:Run 分组第一行显示 Turn N,其余行一个续行点(DSH 同款)。 */}
      <span className="w-10 shrink-0 text-[10px] text-muted-foreground/80">
        {item.isRunStart ? (
          `Turn ${item.runOrdinal}`
        ) : (
          <span className="inline-block w-full text-center text-muted-foreground/40">·</span>
        )}
      </span>
      <span
        className={`inline-flex h-5 w-16 shrink-0 items-center justify-center rounded px-1 text-[10px] font-semibold uppercase tracking-wide ${pill}`}
        style={{ marginLeft: depth === 0 ? 0 : depth === 1 ? 20 : 40 }}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground/90">
        {row.kind === "tool" ? (
          <>
            <span className="font-medium">{row.title}</span>{" "}
            <span className="text-muted-foreground">{preview(payload["args"])}</span>
            {payload["output"] !== undefined && (
              <>
                {" → "}
                <span className={row.status === "error" ? "text-destructive" : "text-muted-foreground"}>
                  {preview(payload["output"])}
                </span>
              </>
            )}
          </>
        ) : (
          <>
            {row.title}
            {row.agent !== "main" && (
              <span className="ml-1 text-muted-foreground">· {row.agent}</span>
            )}
          </>
        )}
      </span>
      {row.stepIndex !== null && (
        <span className="shrink-0 text-muted-foreground/70">S{row.stepIndex}</span>
      )}
      {row.durationMs !== null && (
        <span className="shrink-0 text-muted-foreground">{formatMs(row.durationMs)}</span>
      )}
      {row.status === "error" && row.kind !== "tool" && (
        <span className="size-2 shrink-0 rounded-full bg-destructive" />
      )}
      {row.status === "aborted" && (
        <span className="shrink-0 text-muted-foreground">aborted</span>
      )}
    </div>
  );
}

/** Run 分割线:细分隔线 + Turn 标记;双击折叠/展开整个 Run。 */
export function RunDivider({
  item,
  onToggleRun
}: {
  readonly item: DisplayItem & { type: "run-divider" };
  readonly onToggleRun: (runId: string) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className="flex cursor-pointer items-center gap-2 px-3 py-1 text-[11px] text-muted-foreground select-none"
      onDoubleClick={() => onToggleRun(item.runId)}
      onClick={() => onToggleRun(item.runId)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onToggleRun(item.runId);
      }}
      title="单击/双击折叠或展开这一轮"
    >
      <span className="h-px flex-1 bg-border" />
      <span>
        Turn {item.ordinal}
        {item.folded ? `(${item.hiddenCount} 行已折叠)` : ""}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
