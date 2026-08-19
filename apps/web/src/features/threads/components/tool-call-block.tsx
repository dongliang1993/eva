import { memo, useState } from "react";
import {
  Search,
  Globe,
  FileText,
  Wrench,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp
} from "lucide-react";

import type { ToolCallInfo } from "../../../shared/api/run-stream-client";
import { SubagentCard } from "./subagent-card";

// ---------------------------------------------------------------------------
// Semantic tool display config
// ---------------------------------------------------------------------------

interface ToolDisplay {
  readonly icon: typeof Search;
  readonly getTitle: (args: Record<string, unknown>) => string;
}

const TOOL_DISPLAY: Record<string, ToolDisplay> = {
  web_search: {
    icon: Search,
    getTitle: (args) => String(args.query ?? "Web Search")
  },
  web_fetch: {
    icon: Globe,
    getTitle: (args) => {
      const url = String(args.url ?? "");
      try {
        return new URL(url).hostname;
      } catch {
        return "Fetch Page";
      }
    }
  },
  read_skill: {
    icon: FileText,
    getTitle: (args) => `Read: ${String(args.name ?? "skill")}`
  }
};

const DEFAULT_DISPLAY: ToolDisplay = {
  icon: Wrench,
  getTitle: (_args) => "Tool Call"
};

function getToolDisplay(toolName: string): ToolDisplay {
  // toolName 可能为空(部分 provider 的错误 part 不带名字)—— 别渲染出一张无字空卡。
  return TOOL_DISPLAY[toolName] ?? {
    ...DEFAULT_DISPLAY,
    getTitle: () => (toolName.length > 0 ? toolName : "Tool Call")
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(str: string): string {
  const bytes = new Blob([str]).size;
  if (bytes < 1024) return `${bytes} B total`;
  return `${(bytes / 1024).toFixed(1)} KB total`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ToolCallBlockProps {
  readonly toolCall: ToolCallInfo;
}

function ToolCallBlockImpl({ toolCall }: ToolCallBlockProps) {
  // S7:subagent 调用渲染成子代理卡片(状态按这次调用的 toolCallId 归位)。
  if (toolCall.toolName === "subagent") {
    return <SubagentCard toolCall={toolCall} />;
  }

  const [expanded, setExpanded] = useState(false);
  const [showFullResult, setShowFullResult] = useState(false);

  const display = getToolDisplay(toolCall.toolName);
  const Icon = display.icon;
  const title = display.getTitle(toolCall.args);

  const isSuccess = toolCall.status === "success";
  const isError = toolCall.status === "error";
  const isRunning = !toolCall.status;

  return (
    <div className="my-3 max-w-[60%]">
      {/* Header — always visible */}
      <button
        type="button"
        className="flex w-full items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/50"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <Icon size={16} className="shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          {title}
        </span>

        <div className="flex items-center gap-2 shrink-0">
          {isSuccess ? (
            <CheckCircle2 size={16} className="text-success" />
          ) : isError ? (
            <XCircle size={16} className="text-destructive" />
          ) : null}

          {toolCall.durationMs !== undefined ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock size={12} />
              {formatDuration(toolCall.durationMs)}
            </span>
          ) : isRunning ? (
            <span className="text-xs text-warning animate-pulse">running</span>
          ) : null}

          {expanded ? (
            <ChevronUp size={14} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={14} className="text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded ? (
        <div className="mt-3 space-y-4 pl-1 pl-4">
          {/* Arguments */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Arguments
            </h4>
            <div className="rounded-md border border-border bg-terminal/30 p-3">
              <pre className="text-xs text-foreground font-mono whitespace-pre-wrap break-all">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>
            </div>
          </div>

          {/* Result */}
          {toolCall.output ? (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Result
              </h4>
              <div className="rounded-md border border-border bg-terminal/30">
                <div
                  className={`p-3 overflow-hidden ${showFullResult ? "" : "max-h-[300px]"
                    }`}
                >
                  <pre className="text-xs text-foreground font-mono whitespace-pre-wrap break-all">
                    {toolCall.output}
                  </pre>
                </div>

                {/* Footer with size + show full */}
                {toolCall.output.length > 500 ? (
                  <div className="flex items-center justify-between border-t border-border px-3 py-2">
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(toolCall.output)}
                    </span>
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setShowFullResult((prev) => !prev)}
                    >
                      {showFullResult ? "Collapse" : "Show full output"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Footer meta */}
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>
              Call ID:
              <span className="ml-2 font-mono text-foreground">
                {toolCall.toolCallId}
              </span>
            </span>
            {toolCall.durationMs !== undefined ? (
              <span>Duration: {formatDuration(toolCall.durationMs)}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const ToolCallBlock = memo(ToolCallBlockImpl);
