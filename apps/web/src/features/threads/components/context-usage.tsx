import { useQuery } from "@tanstack/react-query";

import { fetchThreadUsage } from "../api";
import { Tooltip, TooltipProvider } from "../../../shared/ui/tooltip";

/** 把 token 数格式化成 12.4k / 200k 这类紧凑形式。 */
const formatTokens = (value: number | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
};

const formatPct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/**
 * 上下文占用条 + 累计 token。
 * 数据来自 /threads/:id/usage;缓慢轮询(10s),run 结束由 use-chat 的 invalidate 立刻刷新。
 */
export function ContextUsage({ sessionId }: { readonly sessionId: string | null }) {
  const usage = useQuery({
    queryKey: ["thread-usage", sessionId],
    queryFn: () => fetchThreadUsage(sessionId!),
    enabled: sessionId !== null,
    staleTime: 10_000
  });

  if (!sessionId || !usage.data) {
    return null;
  }

  const data = usage.data;
  const contextTokens = formatTokens(data.contextTokens);
  const contextWindow = formatTokens(data.contextWindow);
  const ratio = data.contextRatio;
  const barWidth = ratio === null ? "0%" : `${Math.min(100, Math.max(0, ratio * 100))}%`;
  const totalTokens = data.totalUsage.totalTokens ?? 0;

  const tooltip =
    `上下文占用:${contextTokens ?? "未知"}${contextWindow ? ` / ${contextWindow}` : ""}` +
    ` · 累计 ${totalTokens} token`;

  // Radix Tooltip 需要向上的 Provider 上下文;ContextUsage 渲染在 ChatInput 之上,
  // 不能借用它的 provider,这里自带一个。
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center px-4 py-1.5 text-xs text-muted-foreground">
        <Tooltip content={tooltip}>
          <div className="flex w-44 items-center gap-2">
            <div className="h-1 flex-1 rounded-full bg-border overflow-hidden">
              <div
                className="h-full rounded-full bg-primary/60 transition-all"
                style={{ width: barWidth }}
              />
            </div>
            <span className="tabular-nums whitespace-nowrap">
              {contextTokens ?? "?"}
              {contextWindow ? ` / ${contextWindow}` : ""}
              {ratio !== null ? ` · ${formatPct(ratio)}` : ""}
            </span>
          </div>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}