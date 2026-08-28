import { memo, useState } from "react";
import { Copy, Check, Clock } from "lucide-react";

import type { ToolCallInfo } from "../../../shared/api/run-stream-client";
import { SubagentCard } from "./subagent-card";
import { DisclosureRow } from "./disclosure-row";
import { useWorkspaceName } from "./workspace-name-context";

// ---------------------------------------------------------------------------
// Semantic tool display config —— 只配标题,不再配图标(行首图标位整体去除)
// ---------------------------------------------------------------------------

const TOOL_TITLES: Record<string, (args: Record<string, unknown>) => string> = {
  web_search: (args) => String(args.query ?? "Web Search"),
  web_fetch: (args) => {
    const url = String(args.url ?? "");
    try {
      return new URL(url).hostname;
    } catch {
      return "Fetch Page";
    }
  },
  read_skill: (args) => `Read: ${String(args.name ?? "skill")}`,
  read_file: (args) => `Read: ${String(args.path ?? "file")}`,
  grep: (args) => `Grep: ${String(args.pattern ?? args.query ?? "")}`
};

function getToolTitle(toolName: string, args: Record<string, unknown>): string {
  const getTitle = TOOL_TITLES[toolName];
  if (getTitle !== undefined) return getTitle(args);
  // toolName 可能为空(部分 provider 的错误 part 不带名字)——
  return toolName.length > 0 ? toolName : "Tool Call";
}

/** 失败行首的红点 —— 参考 dsh 的 ● Code · Error 行,代替原来的尾随 ✕ icon。 */
function ErrorDot() {
  return <span className="size-2 rounded-full bg-destructive" aria-hidden="true" />;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * T51:三段计时徽章 —— 等待与执行分开呈现,不相加成一个数。
 * 只在 toolExecMs 存在时渲染;旧消息只有含等待的旧 durationMs,一律隐藏
 * (判据是「有没有新字段」,不按消息时间戳猜版本)。
 */
function TimingBadge({ toolCall }: { readonly toolCall: ToolCallInfo }) {
  if (toolCall.toolExecMs === undefined) return null;

  const waits: string[] = [];
  if ((toolCall.approvalWaitMs ?? 0) > 0) {
    waits.push(`等待 ${formatDuration(toolCall.approvalWaitMs ?? 0)}`);
  }
  if ((toolCall.queueWaitMs ?? 0) > 0) {
    waits.push(`排队 ${formatDuration(toolCall.queueWaitMs ?? 0)}`);
  }

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {waits.length > 0 && <span>{waits.join(" · ")}</span>}
      <span className="flex items-center gap-1">
        <Clock size={12} />
        {formatDuration(toolCall.toolExecMs)}
      </span>
    </span>
  );
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

  // bash:终端卡片形态 —— 折叠行标题是「Bash · <一句描述>」,展开是
  // [命令行:状态点 + 主机标签 + 命令 + 复制] → 结果,不是通用 Arguments/Result 两段。
  if (toolCall.toolName === "bash") {
    return <BashToolCall toolCall={toolCall} />;
  }

  const title = getToolTitle(toolCall.toolName, toolCall.args);

  const isError = toolCall.status === "error";
  const isRunning = !toolCall.status;

  // T30 刷新恢复:已决策审批在 tool part 上定格成「已允许/已拒绝 · 时间」徽标。
  const approvalBadge = toolCall.approvalDecision ? (
    <span
      className={`flex items-center gap-1 text-xs ${
        toolCall.approvalDecision.action === "granted" ? "text-primary" : "text-destructive"
      }`}
    >
      {toolCall.approvalDecision.action === "granted" ? "已允许" : "已拒绝"} ·{" "}
      {new Date(toolCall.approvalDecision.decidedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      })}
    </span>
  ) : null;

  return (
    <DisclosureRow
      {...(isError ? { leadingDot: <ErrorDot /> } : {})}
      title={
        isError
          ? `${toolCall.toolName} · Error: ${title}`
          : `${toolCall.toolName}${title ? ` · ${title}` : ""}`
      }
      trailing={
        approvalBadge ??
        (toolCall.toolExecMs !== undefined && !isError ? (
          <TimingBadge toolCall={toolCall} />
        ) : isRunning ? (
          <span className="text-xs text-warning animate-pulse">running</span>
        ) : null)
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
          <ResultBlock output={toolCall.output} {...(isError ? { error: true } : {})} />
        ) : null}
      </div>
    </DisclosureRow>
  );
}

/** 工具结果:默认折叠超过 300px 高,底部给尺寸 + Show full output;失败时红点 + 红字。 */
function ResultBlock({ output, error }: { readonly output: string; readonly error?: boolean }) {
  const [showFull, setShowFull] = useState(false);
  const long = output.length > 500;

  return (
    <div>
      <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {error === true ? (
          <span className="size-1.5 rounded-full bg-destructive" aria-hidden="true" />
        ) : null}
        Result
      </h4>
      <div className="overflow-hidden rounded-md border border-border bg-terminal/30">
        <div className={`p-3 ${showFull ? "" : "max-h-[300px]"}`}>
          <pre
            className={`font-mono text-xs whitespace-pre-wrap break-all ${
              error === true ? "text-destructive" : "text-foreground"
            }`}
          >
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

// ---------------------------------------------------------------------------
// bash 专属终端卡片 —— 折叠行「Bash · <描述>」,展开 = 命令行 + 结果
// ---------------------------------------------------------------------------

/**
 * 命令复制按钮:点击写命令到剪贴板,短暂回显「已复制」。
 * 自管 copied 态,1.2s 后回落 —— 不在外层存,避免一个工具行拖动整个 memo 树。
 */
function CopyCommandButton({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        // 剪贴板权限被拒(非安全上下文等)静默:按钮仍在,只是没复制成功。
      });
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      aria-label="复制命令"
    >
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      <span>{copied ? "已复制" : "复制"}</span>
    </button>
  );
}

/**
 * bash 结果:直接铺在分割线下,不再包独立块/RESULT 标签。
 * 长输出(>500 字)默认限高 300px,底部给尺寸 + Show full output;失败时红点 + 红字。
 */
function BashResult({ output, error }: { readonly output: string; readonly error?: boolean }) {
  const [showFull, setShowFull] = useState(false);
  const long = output.length > 500;

  return (
    <div className="px-6 py-2">
      <div className={showFull ? "" : "max-h-[300px] overflow-hidden"}>
        <div className="flex items-start gap-2">
          {error === true ? (
            <span className="mt-1 size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
          ) : null}
          <pre
            className={`font-mono text-xs whitespace-pre-wrap break-all ${
              error === true ? "text-destructive" : "text-foreground"
            }`}
          >
            {output}
          </pre>
        </div>
      </div>
      {long ? (
        <div className="mt-2 flex items-center justify-between">
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
  );
}

/**
 * bash 展开体:单张卡片 —— 命令行作标题,贯通分割线,结果在线下。
 * 不再用通用 Arguments/Result 两段,也不给结果单独的块级容器/标签。
 */
function BashBody({ toolCall }: { readonly toolCall: ToolCallInfo }) {
  const command = typeof toolCall.args.command === "string" ? toolCall.args.command : "";
  const workspaceName = useWorkspaceName();
  const isError = toolCall.status === "error";

  return (
    <div className="overflow-hidden rounded-md border border-border bg-terminal/30">
      {/* 标题行:状态点(失败红/其余绿)+ 主机标签 + 命令 + 复制 */}
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span
          className={`size-2 shrink-0 rounded-full ${isError ? "bg-destructive" : "bg-success"}`}
          aria-hidden="true"
        />
        {workspaceName !== null ? (
          <span className="shrink-0 font-mono text-xs text-secondary-foreground">
            {workspaceName}
          </span>
        ) : null}
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {command}
        </code>
        <CopyCommandButton command={command} />
      </div>

      {/* 贯通分割线:有结果时才画,线就是标题与结果的分界 */}
      {toolCall.output ? (
        <>
          <div className="border-t border-border" />
          <BashResult output={toolCall.output} {...(isError ? { error: true } : {})} />
        </>
      ) : null}
    </div>
  );
}

function BashToolCall({ toolCall }: ToolCallBlockProps) {
  const description = typeof toolCall.args.description === "string" ? toolCall.args.description.trim() : "";
  const command = typeof toolCall.args.command === "string" ? toolCall.args.command.trim() : "";
  // 标题优先描述;没描述退到命令 —— 旧会话/模型没给 description 时仍有可读标题。
  const subtitle = description.length > 0 ? description : command.length > 0 ? command : "bash";

  const isError = toolCall.status === "error";
  const isRunning = !toolCall.status;

  return (
    <DisclosureRow
      {...(isError ? { leadingDot: <ErrorDot /> } : {})}
      title={isError ? `Bash · Error: ${subtitle}` : `Bash · ${subtitle}`}
      trailing={
        toolCall.toolExecMs !== undefined && !isError ? (
          <TimingBadge toolCall={toolCall} />
        ) : isRunning ? (
          <span className="text-xs text-warning animate-pulse">running</span>
        ) : null
      }
    >
      <BashBody toolCall={toolCall} />
    </DisclosureRow>
  );
}

export const ToolCallBlock = memo(ToolCallBlockImpl);