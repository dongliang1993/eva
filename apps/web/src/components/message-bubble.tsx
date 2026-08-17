import { useState } from "react";
import { Brain, ChevronDown, ChevronUp } from "lucide-react";
import "streamdown/styles.css";

import type { DisplayMessage } from "../hooks/use-chat";
import { StreamMarkdown } from "../shared/markdown/markdown.js";
import { useSmoothStream } from "../shared/streaming/use-smooth-stream.js";
import { StreamingIndicator } from "./streaming-indicator";
import { ToolCallBlock } from "./tool-call-block";

interface MessageBubbleProps {
  readonly message: DisplayMessage;
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

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="relative max-w-[75%]">
          <div className="rounded-3xl rounded-tr-xs bg-user-bubble px-4 py-2.5 text-sm text-user-bubble-foreground">
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-none">
      {message.thinkingDurationMs !== undefined && message.thinkingDurationMs > 0 ? (
        <ThinkingBadge durationMs={message.thinkingDurationMs} />
      ) : null}

      {message.toolCalls?.map((tc) => (
        <ToolCallBlock key={tc.toolCallId} toolCall={tc} />
      ))}

      <AssistantContent content={message.content} isStreaming={message.isStreaming} />
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
