import type { DisplayMessage } from "../hooks/use-chat";
import type { PendingApproval } from "../api/approvals";
import { MessageList } from "./message-list";
import { ApprovalCard } from "./approval-card";
import { ChatInput } from "./chat-input";

interface ChatViewProps {
  readonly messages: readonly DisplayMessage[];
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
  return (
    <div className="flex h-full flex-col bg-background">
      <MessageList messages={messages} />

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
