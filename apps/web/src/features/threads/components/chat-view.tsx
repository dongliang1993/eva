import type { ApprovalDecision, EvaUIMessage, PlanReviewDecision } from "@eva/shared";

import type { PendingApproval, PendingPlanReview, PlanReviewClientOutcome } from "../api";
import { useWorkspaces } from "../../workspaces/hooks/use-workspaces";
import { isElectron } from "../../../shared/runtime";
import { MessageList } from "./message-list";
import { ApprovalCard } from "./approval-card";
import { PlanReviewCard } from "./plan-review-card";
import { ChatInput, type ChatInputRejection } from "./chat-input";
import { WorkspaceNameProvider } from "./workspace-name-context";
import { useStickToBottom } from "../hooks/use-stick-to-bottom";
import { useState } from "react";
import { TrajectoryView } from "../trajectory/trajectory-view";

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
  /** T45b:plan review 待决与定格态。 */
  readonly pendingPlanReviews?: readonly PendingPlanReview[];
  readonly resolvedPlanReviews?: Readonly<Record<string, PlanReviewDecision>>;
  readonly onDecidePlanReview?: (
    callId: string,
    outcome: PlanReviewClientOutcome,
    payload?: { feedback?: string; selectedLabel?: string }
  ) => void;
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
  pendingPlanReviews,
  resolvedPlanReviews,
  onDecidePlanReview,
  rejection,
  onRejectionSeen
}: ChatViewProps) {
  const { containerRef, isAtBottom, scrollToBottom } = useStickToBottom(streamingMessage);

  // 「对话 / 轨迹」切换(T53):聊天流不卸载 —— 切走只是隐藏,回来时消息/滚动位置原样。
  const [view, setView] = useState<"chat" | "trajectory">("chat");
  // 轨迹页首次打开后保持挂载(再切回来不重拉数据)。
  const [trajectoryOpened, setTrajectoryOpened] = useState(false);

  // 会话切换回到对话视图;轨迹的打开标记也一起重置。
  const [lastSessionId, setLastSessionId] = useState<string | null>(sessionId);
  if (sessionId !== lastSessionId) {
    setLastSessionId(sessionId);
    setView("chat");
    setTrajectoryOpened(false);
  }

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

        {/* 「对话 / 轨迹」切换(T53)。聊天流不卸载,切走只是 hidden —— 回来时
            消息、builder、滚动位置全部原样;轨迹页首开后再切走也保持挂载。 */}
        {sessionId ? (
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-1.5">
            {(["chat", "trajectory"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className={`rounded-md px-3 py-1 text-xs transition-colors ${
                  view === tab
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50"
                }`}
                onClick={() => {
                  setView(tab);
                  if (tab === "trajectory") setTrajectoryOpened(true);
                }}
              >
                {tab === "chat" ? "对话" : "轨迹"}
              </button>
            ))}
          </div>
        ) : null}

        <div className={view === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
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

        {pendingPlanReviews?.map((review) => (
          <div key={review.callId} className="flex justify-start px-4">
            <PlanReviewCard
              review={review}
              {...(resolvedPlanReviews?.[review.callId]
                ? { resolved: resolvedPlanReviews[review.callId] }
                : {})}
              onDecide={(callId, outcome, payload) =>
                onDecidePlanReview?.(callId, outcome, payload)
              }
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

        {trajectoryOpened && sessionId ? (
          <div className={view === "trajectory" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <TrajectoryView sessionId={sessionId} />
          </div>
        ) : null}
      </div>
    </WorkspaceNameProvider>
  );
}