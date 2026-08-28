import { useMemo } from "react";

import type { TrajectoryRow } from "./derive-trajectory";

/**
 * 三泳道 Overview(T54):Input / Model / Tools,横轴真实时间比例。
 * - Model 泳道按 TTFT(等首 token)与 decoding 分段着色;
 * - Tools 泳道把审批等待 / 排队等待 / 真实执行画成同一条上的三段,不相加;
 * - 相邻 Step 的间隙(orchestration gap)靠真实比例自然留白,不压缩、不吞掉;
 * - 点任一段 → 台账滚到对应行并选中。
 */

interface Span {
  readonly key: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly className: string;
  readonly title: string;
}

const LANE_LABELS = ["Input", "Model", "Tools"] as const;

const pct = (value: number, base: number, range: number): string =>
  `${(((value - base) / range) * 100).toFixed(3)}%`;

const formatMs = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

function Lane({
  label,
  spans,
  minMs,
  rangeMs,
  equalWidth,
  onJump
}: {
  readonly label: string;
  readonly spans: readonly Span[];
  readonly minMs: number;
  readonly rangeMs: number;
  /** 等宽顺序模式:段按顺序等分泳道,不看真实时长(DSH 工具栏 Duration 关闭态)。 */
  readonly equalWidth: boolean;
  readonly onJump: (key: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <div className="relative h-4 flex-1 rounded bg-muted/40">
        {spans.map((span, index) => (
          <button
            key={span.key + span.startMs}
            type="button"
            title={span.title}
            onClick={() => onJump(span.key)}
            className={`absolute top-0.5 h-3 rounded-sm ${span.className} hover:opacity-70 transition-opacity`}
            style={
              equalWidth
                ? {
                    left: `${((index / Math.max(spans.length, 1)) * 100).toFixed(3)}%`,
                    width: `max(2px, ${(100 / Math.max(spans.length, 1)).toFixed(3)}%)`
                  }
                : {
                    left: pct(span.startMs, minMs, rangeMs),
                    width: `max(2px, ${((span.durationMs / rangeMs) * 100).toFixed(3)}%)`
                  }
            }
          />
        ))}
      </div>
    </div>
  );
}

export function TrajectoryOverview({
  rows,
  onJump,
  actualDuration = true
}: {
  readonly rows: readonly TrajectoryRow[];
  readonly onJump: (key: string) => void;
  /** true = 真实时长比例(默认);false = 等宽顺序(DSH 工具栏的 Duration 开关)。 */
  readonly actualDuration?: boolean;
}) {
  const { inputSpans, modelSpans, toolSpans, minMs, rangeMs } = useMemo(() => {
    const starts = rows
      .map((row) => row.startedAtMs)
      .filter((ms): ms is number => ms !== null);
    if (starts.length === 0) {
      return { inputSpans: [], modelSpans: [], toolSpans: [], minMs: 0, rangeMs: 1 };
    }
    const min = Math.min(...starts);
    const max = Math.max(
      ...rows.map((row) => (row.startedAtMs ?? min) + (row.durationMs ?? 0))
    );
    const range = Math.max(max - min, 1);

    const input: Span[] = [];
    const model: Span[] = [];
    const tools: Span[] = [];

    for (const row of rows) {
      if (row.startedAtMs === null) continue;
      if (row.kind === "user" || row.kind === "system" || row.kind === "context") {
        input.push({
          key: row.key,
          startMs: row.startedAtMs,
          durationMs: Math.max(row.durationMs ?? 0, range * 0.002),
          className: row.kind === "system" ? "bg-purple-400/80" : "bg-sky-400/80",
          title: row.title
        });
      } else if (row.kind === "assistant" && row.durationMs !== null) {
        // TTFT 段(等首 token)与 decoding 段分开着色。
        const ttft = row.timing?.ttftMs;
        model.push({
          key: row.key,
          startMs: row.startedAtMs,
          durationMs: ttft !== undefined ? ttft : row.durationMs,
          className: "bg-emerald-500/80",
          title: `${row.title} · TTFT ${ttft !== undefined ? formatMs(ttft) : "?"}`
        });
        if (ttft !== undefined && row.durationMs > ttft) {
          model.push({
            key: row.key,
            startMs: row.startedAtMs + ttft,
            durationMs: row.durationMs - ttft,
            className: "bg-emerald-300/80",
            title: `${row.title} · decoding ${formatMs(row.durationMs - ttft)}`
          });
        }
      } else if (row.kind === "tool" && row.durationMs !== null) {
        // 三段:审批等待 → 排队等待 → 真实执行。不相加,各看各的。
        const approval = row.timing?.approvalWaitMs ?? 0;
        const queue = row.timing?.queueWaitMs ?? 0;
        const exec = row.timing?.execMs ?? row.durationMs;
        let cursor = row.startedAtMs;
        if (approval > 0) {
          tools.push({
            key: row.key,
            startMs: cursor,
            durationMs: approval,
            className: "bg-amber-400/90",
            title: `${row.title} · 审批等待 ${formatMs(approval)}`
          });
          cursor += approval;
        }
        if (queue > 0) {
          tools.push({
            key: row.key,
            startMs: cursor,
            durationMs: queue,
            className: "bg-orange-300/90",
            title: `${row.title} · 排队等待 ${formatMs(queue)}`
          });
          cursor += queue;
        }
        tools.push({
          key: row.key,
          startMs: cursor,
          durationMs: Math.max(exec, 0),
          className: row.status === "error" ? "bg-destructive/80" : "bg-emerald-500/80",
          title: `${row.title} · 执行 ${formatMs(exec)}`
        });
      }
    }

    return { inputSpans: input, modelSpans: model, toolSpans: tools, minMs: min, rangeMs: range };
  }, [rows]);

  if (rows.length === 0) return null;

  return (
    <div className="space-y-1 border-b border-border px-3 py-2">
      {LANE_LABELS.map((label, index) => (
        <Lane
          key={label}
          label={label}
          spans={[inputSpans, modelSpans, toolSpans][index]!}
          minMs={minMs}
          rangeMs={rangeMs}
          equalWidth={!actualDuration}
          onJump={onJump}
        />
      ))}
    </div>
  );
}
