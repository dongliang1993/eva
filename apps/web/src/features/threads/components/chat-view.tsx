import type { EvaUIMessage } from "@eva/shared";

import type { PendingApproval } from "../api";
import { useWorkspaces } from "../../workspaces/hooks/use-workspaces";
import { MessageList } from "./message-list";
import { ApprovalCard } from "./approval-card";
import { ChatInput, type ChatInputRejection } from "./chat-input";
import { ContextUsage } from "./context-usage";
import { WorkspaceNameProvider } from "./workspace-name-context";
import { useStickToBottom } from "../hooks/use-stick-to-bottom";

interface ChatViewProps {
  readonly messages: readonly EvaUIMessage[];
  readonly streamingMessage: EvaUIMessage | null;
  readonly isStreaming: boolean;
  readonly selectedModel: string | null;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
  readonly onSelectModel: (modelId: string) => void;
  readonly workspaceId: string | null;
  readonly onSelectWorkspace: (workspaceId: string | null) => void;
  readonly sessionId: string | null;
  readonly pendingApprovals?: readonly PendingApproval[];
  readonly onApproveOnce?: (callId: string) => void;
  readonly onDeny?: (callId: string) => void;
  readonly onAllowAlways?: (callId: string) => void;
  /** 上一句被 409 拒收:输入框回填 + 提示(见 ChatInput)。 */
  readonly rejection?: ChatInputRejection | null;
  readonly onRejectionSeen?: () => void;
}

export function ChatView({
  messages,
  streamingMessage,
  isStreaming,
  selectedModel,
  onSend,
  onStop,
  onSelectModel,
  workspaceId,
  onSelectWorkspace,
  sessionId,
  pendingApprovals,
  onApproveOnce,
  onDeny,
  onAllowAlways,
  rejection,
  onRejectionSeen
}: ChatViewProps) {
  const { containerRef, isAtBottom, scrollToBottom } = useStickToBottom(streamingMessage);

  // bash 命令行的主机标签(work-mi 这种)用工作区名 —— 它就是"命令在哪跑"。
  const { workspaces } = useWorkspaces();
  const workspaceName =
    workspaceId !== null
      ? workspaces.find((w) => w.id === workspaceId)?.name ?? null
      : null;

  return (
    <WorkspaceNameProvider name={workspaceName}>
      <div className="flex h-full flex-col bg-background">
        <ContextUsage sessionId={sessionId} />
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
        workspaceId={workspaceId}
        onSelectWorkspace={onSelectWorkspace}
        rejection={rejection ?? null}
        {...(onRejectionSeen ? { onRejectionSeen } : {})}
      />
    </div>
    </WorkspaceNameProvider>
  );
}