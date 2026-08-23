import { useQuery } from "@tanstack/react-query";

import { fetchThreadUsage } from "../api";
import { Tooltip, TooltipProvider } from "../../../shared/ui/tooltip";

/** token 数的紧凑格式:82.2k / 1M / 200k。 */
const formatTokens = (value: number | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
};

/**
 * 上下文占用环形圈(输入框右下角),口径与 Kimi 的 context: 33% (82.2k/256k) 一致:
 * 分子 = 当前历史占用的 token,分母 = 模型上下文窗口 token,圆环随占比撑满。
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
  const ratio = data.contextRatio ?? 0;
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const contextTokens = formatTokens(data.contextTokens);
  const contextWindow = formatTokens(data.contextWindow);

  const tooltip = `上下文占用:${contextTokens ?? "未知"}${contextWindow ? ` / ${contextWindow}` : ""} token`;

  // 16px 圆环,半径 6,线宽 2。周长 2πr ≈ 37.7。
  const r = 6;
  const circumference = 2 * Math.PI * r;
  const filled = (pct / 100) * circumference;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip content={tooltip}>
        <div className="flex items-center gap-1 text-muted-foreground">
          <svg width={16} height={16} viewBox="0 0 16 16" className="-rotate-90">
            {/* 暗色轨道 */}
            <circle
              cx={8}
              cy={8}
              r={r}
              fill="none"
              strokeWidth={2}
              className="stroke-border"
            />
            {/* 亮色弧:随占比增长 */}
            <circle
              cx={8}
              cy={8}
              r={r}
              fill="none"
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={`${filled} ${circumference - filled}`}
              className="stroke-primary transition-all duration-300"
            />
          </svg>
          <span className="tabular-nums text-xs">{pct}%</span>
        </div>
      </Tooltip>
    </TooltipProvider>
  );
}
