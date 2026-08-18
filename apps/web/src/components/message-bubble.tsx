import { memo, useState } from "react";
import { Brain, ChevronDown, ChevronUp } from "lucide-react";
import "streamdown/styles.css";

import type { EvaUIMessage } from "@eva/shared";
import { isDynamicToolPart, isTextPart, uiMessageText } from "@eva/shared";

import { StreamMarkdown } from "../shared/markdown/markdown.js";
import { useSmoothStream } from "../shared/streaming/use-smooth-stream.js";
import { toolPartToInfo } from "../api/client";
import { StreamingIndicator } from "./streaming-indicator";
import { ToolCallBlock } from "./tool-call-block";

interface MessageBubbleProps {
  readonly message: EvaUIMessage;
  readonly isStreaming?: boolean;
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

function MessageBubbleImpl({ message, isStreaming }: MessageBubbleProps) {
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

  return (
    <div className="max-w-none">
      {thinkingMs !== undefined && thinkingMs > 0 ? (
        <ThinkingBadge durationMs={thinkingMs} />
      ) : null}

      {message.parts.map((part, index) => {
        if (isTextPart(part)) {
          return (
            <AssistantContent
              key={`text-${index}`}
              content={part.text}
              isStreaming={isStreaming === true && part.state === "streaming"}
            />
          );
        }

        if (isDynamicToolPart(part)) {
          return <ToolCallBlock key={part.toolCallId} toolCall={toolPartToInfo(part)} />;
        }

        // step-start 等不渲染
        return null;
      })}

      {message.parts.length === 0 ? <StreamingIndicator /> : null}
    </div>
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