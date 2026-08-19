import { type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { EvaUIMessage } from "@eva/shared";

import { MessageBubble } from "./message-bubble";
import { CommittedMessages } from "./committed-messages";

/**
 * 超过这个条数才启用虚拟化。
 * 40 条约等于 3–4 屏,低于它虚拟化的测量开销比省下的渲染开销还大。
 */
const VIRTUALIZE_THRESHOLD = 40;

interface MessageListProps {
  readonly messages: readonly EvaUIMessage[];
  readonly streamingMessage: EvaUIMessage | null;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly isAtBottom: boolean;
  readonly scrollToBottom: (behavior?: ScrollBehavior) => void;
}

interface VirtualizedMessagesProps {
  readonly messages: readonly EvaUIMessage[];
  readonly scrollRef: RefObject<HTMLDivElement | null>;
}

function VirtualizedMessages({ messages, scrollRef }: VirtualizedMessagesProps) {
  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.id;
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    // 一条消息的高度初值。实际高度由 measureElement 动态测。
    estimateSize: () => 120,
    overscan: 6
  });

  return (
    <div
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: "100%",
        position: "relative"
      }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const message = messages[virtualItem.index]!;
        return (
          <div
            key={message.id}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualItem.start}px)`
            }}
          >
            <MessageBubble
              message={message}
              isLastAssistant={message.id === lastAssistantId}
            />
          </div>
        );
      })}
    </div>
  );
}

function ScrollToBottomButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="sticky bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent/50"
    >
      回到底部
    </button>
  );
}

export function MessageList({
  messages,
  streamingMessage,
  containerRef,
  isAtBottom,
  scrollToBottom
}: MessageListProps) {
  if (messages.length === 0 && streamingMessage === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-light text-muted-foreground mb-2">Eva</h1>
          <p className="text-sm text-muted-foreground/60">Ask me anything</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="message-list-scroll flex-1 overflow-y-auto px-4 py-6 space-y-4 mx-4">
      {messages.length > VIRTUALIZE_THRESHOLD ? (
        <VirtualizedMessages messages={messages} scrollRef={containerRef} />
      ) : (
        <CommittedMessages messages={messages} />
      )}

      {/* 在飞的消息不进虚拟列表:它高度每帧都在变,测量它等于每帧全量 reflow */}
      {streamingMessage !== null ? (
        <MessageBubble message={streamingMessage} isStreaming />
      ) : null}

      {isAtBottom ? null : <ScrollToBottomButton onClick={() => scrollToBottom("smooth")} />}
    </div>
  );
}