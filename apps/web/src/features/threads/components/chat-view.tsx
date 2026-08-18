import type { EvaUIMessage } from "@eva/shared";

import type { PendingApproval } from "../api";
import { MessageList } from "./message-list";
import { ApprovalCard } from "./approval-card";
import { ChatInput } from "./chat-input";
import { useStickToBottom } from "../hooks/use-stick-to-bottom";

interface ChatViewProps {
  readonly messages: readonly EvaUIMessage[];
  readonly streamingMessage: EvaUIMessage | null;
  readonly isStreaming: boolean;
  readonly selectedModel: string | null;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
  readonly onSelectModel: (modelId: string) => void;
  readonly pendingApprovals?: readonly PendingApproval[];
  readonly onApproveOnce?: (callId: string) => void;
  readonly onDeny?: (callId: string) => void;
  readonly onAllowAlways?: (callId: string) => void;
}

export function ChatView({
  messages,
  streamingMessage,
  isStreaming,
  selectedModel,
  onSend,
  onStop,
  onSelectModel,
  pendingApprovals,
  onApproveOnce,
  onDeny,
  onAllowAlways
}: ChatViewProps) {
  const { containerRef, isAtBottom, scrollToBottom } = useStickToBottom(streamingMessage);

  return (
    <div className="flex h-full flex-col bg-background">
      <MessageList
        messages={messages}
        streamingMessage={streamingMessage}
        containerRef={containerRef}
        isAtBottom={isAtBottom}
        scrollToBottom={scrollToBottom}
      />

      {pendingApprovals?.map((approval) => (
        <div key={approval.callId} className="flex justify-start px-4">
          <ApprovalCard
            approval={approval}
            onDecide={(callId, allowed) => (allowed ? onApproveOnce?.(callId) : onDeny?.(callId))}
            onAllowAlways={(callId) => onAllowAlways?.(callId)}
          />
        </div>
      ))}

      <ChatInput
        onSend={onSend}
        onStop={onStop}
        disabled={isStreaming}
        isStreaming={isStreaming}
        selectedModel={selectedModel}
        onSelectModel={onSelectModel}
      />
    </div>
  );
}