import { memo, useState } from "react";
import { Search, Globe, FileText, Wrench, CheckCircle2, XCircle, Clock } from "lucide-react";

import type { ToolCallInfo } from "../../../shared/api/run-stream-client";
import { SubagentCard } from "./subagent-card";
import { DisclosureRow } from "./disclosure-row";

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
  },
  // 读取类工具统一 📄,对齐参考里的 Read 行。
  read_file: {
    icon: FileText,
    getTitle: (args) => `Read: ${String(args.path ?? "file")}`
  },
  grep: {
    icon: FileText,
    getTitle: (args) => `Grep: ${String(args.pattern ?? args.query ?? "")}`
  }
};

const DEFAULT_DISPLAY: ToolDisplay = {
  icon: Wrench,
  getTitle: (_args) => "Tool Call"
};

function getToolDisplay(toolName: string): ToolDisplay {
  // toolName 可能为空(部分 provider 的错误 part 不带名字)——
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
// Component — DeepSeek 扁平披露行(无边框无底色),不再是圆角卡片
// ---------------------------------------------------------------------------

interface ToolCallBlockProps {
  readonly toolCall: ToolCallInfo;
}

function ToolCallBlockImpl({ toolCall }: ToolCallBlockProps) {
  // S7:subagent 调用渲染成子代理卡片(状态按这次调用的 toolCallId 归位)。
  if (toolCall.toolName === "subagent") {
    return <SubagentCard toolCall={toolCall} />;
  }

  const display = getToolDisplay(toolCall.toolName);
  const Icon = display.icon;
  const title = display.getTitle(toolCall.args);

  const isSuccess = toolCall.status === "success";
  const isError = toolCall.status === "error";
  const isRunning = !toolCall.status;

  return (
    <DisclosureRow
      icon={<Icon size={14} className="shrink-0" />}
      title={`${toolCall.toolName}${title ? ` · ${title}` : ""}`}
      trailing={
        isSuccess ? (
          <CheckCircle2 size={14} className="text-success" />
        ) : isError ? (
          <XCircle size={14} className="text-destructive" />
        ) : toolCall.durationMs !== undefined ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock size={12} />
            {formatDuration(toolCall.durationMs)}
          </span>
        ) : isRunning ? (
          <span className="text-xs text-warning animate-pulse">running</span>
        ) : null
      }
    >
      <div className="space-y-4">
        {/* Arguments */}
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Arguments
          </h4>
          <div className="rounded-md border border-border bg-terminal/30 p-3">
            <pre className="font-mono text-xs whitespace-pre-wrap break-all text-foreground">
              {JSON.stringify(toolCall.args, null, 2)}
            </pre>
          </div>
        </div>

        {/* Result */}
        {toolCall.output ? (
          <ResultBlock output={toolCall.output} />
        ) : null}
      </div>
    </DisclosureRow>
  );
}

/** 工具结果:默认折叠超过 300px 高,底部给尺寸 + Show full output。 */
function ResultBlock({ output }: { readonly output: string }) {
  const [showFull, setShowFull] = useState(false);
  const long = output.length > 500;

  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Result
      </h4>
      <div className="overflow-hidden rounded-md border border-border bg-terminal/30">
        <div className={`p-3 ${showFull ? "" : "max-h-[300px]"}`}>
          <pre className="font-mono text-xs whitespace-pre-wrap break-all text-foreground">
            {output}
          </pre>
        </div>
        {long ? (
          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">{formatBytes(output)}</span>
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => setShowFull((v) => !v)}
            >
              {showFull ? "Collapse" : "Show full output"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const ToolCallBlock = memo(ToolCallBlockImpl);