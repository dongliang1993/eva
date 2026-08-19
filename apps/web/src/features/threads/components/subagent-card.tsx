import { memo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Users,
  XCircle
} from "lucide-react";

import { uiMessageText } from "@eva/shared";

import type { ToolCallInfo } from "../../../shared/api/run-stream-client";
import { StreamMarkdown } from "../../../shared/markdown/markdown.js";
import { useSubagents } from "./subagents-context";

interface SubagentCardProps {
  readonly toolCall: ToolCallInfo;
}

/** TaskOutput 的输出里夹带的任务号(如 "Task t_abc still running")。 */
const extractTaskId = (output: string): string | undefined => {
  const match = output.match(/Task (t_[A-Za-z0-9_]+)/);
  return match?.[1];
};

/**
 * Task / TaskOutput 调用的渲染:角色 + 状态点(running/done/failed)
 * + 可展开的子代理过程。
 *
 * 数据两源:
 * - 流式中:当轮的 subagent_update 按 parentToolCallId(== 本卡片的 toolCallId)
 *   累积出 message / 状态,进 store;
 * - 刷新/切换后:任务已落库,展开时经 store.loadForToolCall 走
 *   /subagent-messages 兜底取那棵子树。
 */
function SubagentCardImpl({ toolCall }: SubagentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { byToolCallId, loadForToolCall } = useSubagents();

  const state = byToolCallId[toolCall.toolCallId];
  // 既不在 live 也没拉到时维持 running 占位(卡片仍可展开,展开即触发拉取)。
  const status = state?.status ?? "running";
  // 首帧到达前 state 还是空的 —— 用 Task 的入参兜底,别显示 "subagent" 占位符。
  // (harness 侧 subagent 缺省即 explorer,这里与之对齐。)
  const subagentType =
    state?.subagentType ??
    (toolCall.args.subagent !== undefined ? String(toolCall.args.subagent) : "explorer");

  // 卡片只渲染 Task(入参里没有 taskId),任务号从它的输出里取
  // ("Started subagent task t_xxx.");前台 Task(background=false)直接返回答案,没有任务号。
  const taskId = toolCall.output ? extractTaskId(toolCall.output) : undefined;

  const handleToggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    // 首次展开(且刷新恢复态)才拉 /subagent-messages;live 在跑的不覆盖。
    if (next && !state) {
      loadForToolCall(toolCall.toolCallId);
    }
  };

  const statusIcon =
    status === "done" ? (
      <CheckCircle2 size={16} className="text-success" />
    ) : status === "failed" ? (
      <XCircle size={16} className="text-destructive" />
    ) : (
      <Loader2 size={16} className="text-warning animate-spin" />
    );

  return (
    <div className="my-3 max-w-[60%] rounded-md border border-border bg-card">
      <button
        type="button"
        className="flex w-full items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/50"
        onClick={handleToggle}
      >
        <Users size={16} className="shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          Subagent · {subagentType}
          {taskId !== undefined ? (
            <span className="ml-2 font-mono text-xs text-muted-foreground">
              {taskId}
            </span>
          ) : null}
        </span>

        <span className="flex items-center gap-2 shrink-0">
          {statusIcon}
          {expanded ? (
            <ChevronUp size={14} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={14} className="text-muted-foreground" />
          )}
        </span>
      </button>

      {expanded ? (
        <div className="mt-1 space-y-3 border-t border-border p-3">
          {state?.result ? (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Result
              </h4>
              <div className="max-h-[300px] overflow-hidden rounded-md border border-border bg-terminal/30 p-3">
                <StreamMarkdown content={state.result} />
              </div>
            </div>
          ) : state?.error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              {state.error}
            </div>
          ) : null}

          {state && state.message.parts.length > 0 ? (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Process
              </h4>
              <div className="max-h-80 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border bg-terminal/30 p-3 font-mono text-xs text-foreground">
                {uiMessageText(state.message)}
              </div>
            </div>
          ) : status === "running" ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              starting…
            </div>
          ) : null}

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Tool call:
              <span className="ml-1 font-mono text-foreground">
                {toolCall.toolCallId}
              </span>
            </span>
            {state?.live ? <span className="text-xs">streaming live</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const SubagentCard = memo(SubagentCardImpl);