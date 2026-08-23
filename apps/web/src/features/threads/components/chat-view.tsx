import type { ApprovalDecision, EvaUIMessage } from "@eva/shared";

import type { PendingApproval } from "../api";
import { useWorkspaces } from "../../workspaces/hooks/use-workspaces";
import { isElectron } from "../../../shared/runtime";
import { MessageList } from "./message-list";
import { ApprovalCard } from "./approval-card";
import { ChatInput, type ChatInputRejection } from "./chat-input";
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
  /** T30:本次会话内刚决策的定格态(callId → 决策)。 */
  readonly resolvedApprovals?: Readonly<Record<string, ApprovalDecision>>;
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
  resolvedApprovals,
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
        {/* 右侧内容区顶部拖拽栏(仅 Electron):42px 高 + 下划线,与侧栏占位同高,
            折叠后侧栏 0px 时右侧顶部仍与左侧拉齐。可拖拽移动窗口。
            外层整宽只画 border-b(不 drag),内层才是 titlebar-drag —— 这样下划线
            贯通到最左,而可拖热区从 --mac-titlebar-inset 才开始,不吞折叠按钮。 */}
        {isElectron() ? (
          <div className="h-[42px] w-full shrink-0 border-b border-border">
            <div className="titlebar-drag h-full" />
          </div>
        ) : null}
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
            {...(resolvedApprovals?.[approval.callId]
              ? { resolved: resolvedApprovals[approval.callId] }
              : {})}
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
        sessionId={sessionId}
        {...(onRejectionSeen ? { onRejectionSeen } : {})}
      />
    </div>
    </WorkspaceNameProvider>
  );
}