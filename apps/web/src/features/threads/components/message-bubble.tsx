import { memo, useState } from "react";
import { Brain, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, FileText, RotateCcw } from "lucide-react";
import "streamdown/styles.css";

import type { EvaUIMessage } from "@eva/shared";
import { isDynamicToolPart, isReasoningPart, isTextPart, uiMessageText } from "@eva/shared";
import type { EvaDynamicToolPart, EvaTextPart, EvaUIMessagePart } from "@eva/shared";

import { StreamMarkdown } from "../../../shared/markdown/markdown.js";
import { useSmoothStream } from "../../../shared/streaming/use-smooth-stream.js";
import { Tooltip, TooltipProvider } from "../../../shared/ui/tooltip";
import { toolPartToInfo } from "../../../shared/api/run-stream-client";
import { useVersionActions } from "./version-actions-context";
import { StreamingIndicator } from "./streaming-indicator";
import { ToolCallBlock } from "./tool-call-block";
import { DisclosureRow } from "./disclosure-row";

interface MessageBubbleProps {
  readonly message: EvaUIMessage;
  readonly isStreaming?: boolean;
  /** 激活链里的最后一条 assistant(重生成按钮只在它下面出现)。 */
  readonly isLastAssistant?: boolean;
}

/** 同槽位版本切换器:‹ n/m › —— siblingIds.length > 1 时显示。 */
function VersionSwitcher({ messageId }: { readonly messageId: string }) {
  const { siblingIdsById, onSwitchVersion } = useVersionActions();
  const siblings = siblingIdsById[messageId] ?? [messageId];

  if (siblings.length <= 1) {
    return null;
  }

  const index = siblings.indexOf(messageId);
  const current = index >= 0 ? index + 1 : 1;
  const total = siblings.length;

  return (
    <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
      <button
        type="button"
        className="rounded p-1 hover:bg-accent/50 hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
        disabled={current <= 1}
        onClick={() => onSwitchVersion(siblings[current - 2]!)}
        aria-label="上一个版本"
      >
        <ChevronLeft size={14} />
      </button>
      <span className="tabular-nums">
        {current} / {total}
      </span>
      <button
        type="button"
        className="rounded p-1 hover:bg-accent/50 hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
        disabled={current >= total}
        onClick={() => onSwitchVersion(siblings[current]!)}
        aria-label="下一个版本"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

/**
 * 复制 assistant 正文(全部 text part 拼接,不含 Think/工具调用)。
 * 自管 copied 态,1.2s 回显 ✓ 后回落 —— 照 CopyCommandButton 的既有形态。
 */
function CopyMessageButton({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        // 剪贴板权限被拒(非安全上下文等)静默:按钮仍在,只是没复制成功。
      });
  };

  return (
    <Tooltip content="复制">
      <button
        type="button"
        aria-label="复制"
        className="p-1 cursor-pointer flex items-center text-muted-foreground transition-colors hover:text-foreground"
        onClick={onCopy}
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </button>
    </Tooltip>
  );
}

/** 重新生成最后一条回复。纯图标,文案收成 hover tooltip(气泡样式同全站)。 */
function RegenerateButton({ messageId }: { readonly messageId: string }) {
  const { onRegenerate, isStreaming } = useVersionActions();
  if (isStreaming) {
    return null;
  }
  return (
    <Tooltip content="重新生成">
      <button
        type="button"
        aria-label="重新生成"
        className="p-1 cursor-pointer flex items-center text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => onRegenerate(messageId)}
      >
        <RotateCcw size={13} />
      </button>
    </Tooltip>
  );
}

function ThinkingBadge({ durationMs }: { readonly durationMs: number }) {
  const [expanded, setExpanded] = useState(false);
  const seconds = (durationMs / 1000).toFixed(1);

  return (
    <button
      type="button"
      className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      onClick={() => setExpanded((prev) => !prev)}
    >
      <Brain size={14} />
      <span>Thought for {seconds}s</span>
      {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
    </button>
  );
}

/** 渲染分组:一段文字,一串连续的工具调用,或一段推理(Think 块)。 */
type PartGroup =
  | { readonly kind: "text"; readonly part: EvaTextPart }
  | { readonly kind: "tools"; readonly parts: readonly EvaDynamicToolPart[] }
  | { readonly kind: "reasoning"; readonly part: Extract<EvaUIMessagePart, { type: "reasoning" }> };

/**
 * 把 parts 压成交替的「文字段 / 工具组」序列。
 *
 * 连续的工具调用合成一组,组内紧凑排布 —— 否则每张卡各带外边距,和文字段落等距,
 * 视觉上就分不出"这句话"和"它引发的那几次调用"。step-start 等非渲染 part 直接跳过,
 * 且不打断工具组(SDK 在工具之间会插 step-start)。
 */
function groupParts(parts: readonly EvaUIMessagePart[]): readonly PartGroup[] {
  const groups: PartGroup[] = [];

  for (const part of parts) {
    if (isTextPart(part)) {
      groups.push({ kind: "text", part });
      continue;
    }
    if (isReasoningPart(part)) {
      groups.push({ kind: "reasoning", part });
      continue;
    }
    if (!isDynamicToolPart(part)) {
      continue;
    }

    const last = groups[groups.length - 1];
    if (last?.kind === "tools") {
      groups[groups.length - 1] = { kind: "tools", parts: [...last.parts, part] };
    } else {
      groups.push({ kind: "tools", parts: [part] });
    }
  }

  return groups;
}

function MessageBubbleImpl({ message, isStreaming, isLastAssistant }: MessageBubbleProps) {
  // S7:runtime 注入的子代理通知。DB 的 role 枚举只有 user/assistant,所以它以 user
  // 落库 —— 必须先于 user 分支拦掉,否则会渲染成右对齐的用户气泡(像用户自己说的话)。
  const noticeKind = message.metadata?.noticeKind;
  if (noticeKind !== undefined) {
    return (
      <SubagentNotice
        kind={noticeKind}
        description={message.metadata?.noticeDescription}
        text={uiMessageText(message)}
      />
    );
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="relative max-w-[75%]">
          <div className="rounded-3xl rounded-tr-xs bg-user-bubble px-4 py-2.5 text-sm text-user-bubble-foreground">
            <p className="whitespace-pre-wrap">{uiMessageText(message)}</p>
          </div>
        </div>
      </div>
    );
  }

  const thinkingMs = message.metadata?.thinkingDurationMs;
  // 有 reasoning part(会渲染成扁平 Think 行)时不再显示 "Thought for Xs"
  // —— 那是空的等待时长估计,和真实推理轨迹叠一起是噪音。
  const hasReasoning = message.parts.some(isReasoningPart);

  return (
    <div className="max-w-none">
      {thinkingMs !== undefined && thinkingMs > 0 && !hasReasoning ? (
        <ThinkingBadge durationMs={thinkingMs} />
      ) : null}

      {/* 节奏统一由这里的 space-y 控制,part 自己不带 margin —— 否则连续卡片
          被各自的 my-3 撑开后,和文字段落等距,读起来就是"文字夹在卡片队列里"。
          模型常在工具调用之间只吐一两个字(如"再"),碎片文字尤其需要这个层次。 */}
      {groupParts(message.parts).map((group, groupIndex) =>
        group.kind === "text" ? (
          <div key={`text-${groupIndex}`} className="my-4 first:mt-0 last:mb-0">
            <AssistantContent
              content={group.part.text}
              isStreaming={isStreaming === true && group.part.state === "streaming"}
            />
          </div>
        ) : group.kind === "reasoning" ? (
          <ThinkBlock
            key={`reasoning-${groupIndex}`}
            text={group.part.text}
          />
        ) : (
          // 一串连续工具调用收拢成一组:组内紧凑(space-y-1),组与文字之间才宽松。
          <div key={`tools-${groupIndex}`} className="my-4 space-y-1 first:mt-0 last:mb-0">
            {group.parts.map((part) => (
              <ToolCallBlock key={part.toolCallId} toolCall={toolPartToInfo(part)} />
            ))}
          </div>
        )
      )}

      {message.parts.length === 0 ? <StreamingIndicator /> : null}

      {isLastAssistant === true && !isStreaming ? (
        <TooltipProvider delayDuration={300}>
          <div className="flex items-center gap-3">
            <VersionSwitcher messageId={message.id} />
            <CopyMessageButton text={uiMessageText(message)} />
            <RegenerateButton messageId={message.id} />
          </div>
        </TooltipProvider>
      ) : null}
    </div>
  );
}

/**
 * 取 reasoning 的第一句话(标题行预览用)。
 *
 * 按句子/换行断:取第一段非空内容 —— 收口后标题留下的"这段在想什么"
 * 由开头那句代表。流式期间也用它:逐字追加下第一屏很快定形,标题不跳动。
 */
const firstReasoningPreview = (text: string): string => {
  const trimmed = text.trim();
  const leading = trimmed
    .split(/(?<=[。！？.!?\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return leading.length > 0 ? leading[0]! : trimmed;
};

/**
 * Think 块 —— assistant 消息里的推理轨迹(对接 reasoning-delta)。DSH 形态:
 *
 * - 流式期间:标题行显示「Think · <第一句>」,推理过程就滚动在这行上面;
 * - 收口后:标题行保留「Think · <第一句>」的一行预览(truncate 超出省略),
 *   展开/折叠才看全部内容。
 */
function ThinkBlock({ text }: { readonly text: string }) {
  const preview = firstReasoningPreview(text);
  const title = (
    <>
      Think
      {preview.length > 0 ? (
        <>
          <span className="mx-1 text-muted-foreground">·</span>
          <span className="max-w-[60%] truncate font-normal text-secondary-text">
            {preview}
          </span>
        </>
      ) : null}
    </>
  );

  return (
    <DisclosureRow icon={<Brain size={14} className="shrink-0" />} title={title}>
      <div className="whitespace-pre-wrap text-secondary-text">{text}</div>
    </DisclosureRow>
  );
}

/**
 * 子代理通知条 —— 既不是用户气泡也不是 assistant 正文,照 Think/tool 同一套
 * DisclosureRow 渲染(左对齐、无边框、无横线),和其它行平齐。默认折叠:报告
 * 全文往往很长,展开才看。
 *
 * header 只留「已结束/已回报」一个词 + 描述,把注入文本里的担纲头
 * ("Background subagent <id> (<desc>) served:")剥掉 —— 那是写给模型的方向词,
 * 对人读是噪音。
 */
function SubagentNotice({
  kind,
  description,
  text
}: {
  readonly kind: "subagent_reported" | "subagent_settled";
  readonly description?: string | undefined;
  readonly text: string;
}) {
  // 剥掉注入前缀("Background subagent <id> (<desc>) reported:" / "finished and ... more."),
  // 只留子代理真正交付的那段内容。
  const body = text.replace(
    /^Background subagent \S+ \(.*?\) (?:reported:|finished and will do no further work unless you send it more\.)\s*\n?\n?/,
    ""
  );

  const title =
    description !== undefined && description.length > 0
      ? `「${description}」 ${kind === "subagent_reported" ? "已回报" : "已结束"}`
      : kind === "subagent_reported"
        ? "子代理已回报"
        : "子代理已结束";

  return (
    <DisclosureRow
      icon={<FileText size={14} className="shrink-0" />}
      title={title}
      trailing={
        kind === "subagent_reported" ? (
          <CheckCircle2 size={14} className="text-success" />
        ) : undefined
      }
    >
      <div className="rounded-md border border-border bg-terminal/30 p-3">
        {body.length > 0 ? (
          <StreamMarkdown content={body} />
        ) : (
          <StreamMarkdown content={text} />
        )}
      </div>
    </DisclosureRow>
  );
}

/**
 * 流式的 assistant 文本经 rAF 字符泵平滑输出; 静态文本直接渲染。
 * 拆两个子组件避免在条件里调用 hook(rules-of-hooks)。
 */
function AssistantContent({
  content,
  isStreaming
}: {
  readonly content: string;
  readonly isStreaming?: boolean;
}) {
  if (isStreaming) {
    return <SmoothStreamingMarkdown content={content} />;
  }

  if (!content) {
    return <StreamingIndicator />;
  }

  return <StreamMarkdown content={content} />;
}

function SmoothStreamingMarkdown({ content }: { readonly content: string }) {
  const { content: smooth } = useSmoothStream(content);

  if (smooth.length === 0) {
    return <StreamingIndicator />;
  }

  return <StreamMarkdown content={smooth} isStreaming />;
}

export const MessageBubble = memo(MessageBubbleImpl);