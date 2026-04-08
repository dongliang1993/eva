import { useState } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { Brain, ChevronDown, ChevronUp } from "lucide-react";

import type { DisplayMessage } from "../hooks/use-chat";
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

      {message.content ? (
        <div className="max-w-none text-foreground text-sm leading-relaxed">
          <Streamdown>{message.content}</Streamdown>
        </div>
      ) : message.isStreaming ? (
        <StreamingIndicator />
      ) : null}
    </div>
  );
}
