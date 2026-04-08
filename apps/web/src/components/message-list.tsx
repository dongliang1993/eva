import { useEffect, useRef } from "react";

import type { DisplayMessage } from "../hooks/use-chat";
import { MessageBubble } from "./message-bubble";

interface MessageListProps {
  readonly messages: readonly DisplayMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
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
    <div className="message-list-scroll flex-1 overflow-y-auto px-4 py-6 space-y-4 mx-4">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
