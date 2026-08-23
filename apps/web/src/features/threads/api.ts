import { apiFetch } from "../../shared/api/fetch";
import type { ToolRisk } from "@eva/shared";
import type { SubagentMessage, ThreadMessage, ThreadStatus, ThreadSummary, ThreadUsage } from "../../types/api";

export const fetchThreadStatus = async (threadId: string): Promise<ThreadStatus> =>
  apiFetch<ThreadStatus>(`/api/v1/threads/${threadId}/status`);

export const fetchThreadUsage = async (threadId: string): Promise<ThreadUsage> =>
  apiFetch<ThreadUsage>(`/api/v1/threads/${threadId}/usage`);

/** 重命名会话标题。 */
export const renameThread = async (
  threadId: string,
  title: string
): Promise<ThreadSummary> =>
  apiFetch<ThreadSummary>(`/api/v1/threads/${threadId}`, {
    method: "PUT",
    body: JSON.stringify({ title })
  });

/**
 * 删除会话(硬删: messages/runs/usage_records 等对 sessions 都是 onDelete cascade,
 * 整链一起没,不可恢复 —— 调用方必须先确认)。
 */
export const deleteThread = async (threadId: string): Promise<void> =>
  apiFetch<void>(`/api/v1/threads/${threadId}`, { method: "DELETE" });

/** 拉取该会话激活链上的全部消息(含 siblingIds 版本信息)。 */
export const fetchThreadMessages = async (
  threadId: string

): Promise<readonly ThreadMessage[]> =>
  apiFetch<readonly ThreadMessage[]>(`/api/v1/threads/${threadId}/messages`);

/** S7:拉取某次 Task 调用的子代理进程(消息流 + 状态) —— 卡片展开区刷新数据源。 */
export const fetchSubagentMessages = async (
  threadId: string,
  toolCallId: string
): Promise<SubagentMessage> =>
  apiFetch<SubagentMessage>(
    `/api/v1/threads/${threadId}/subagent-messages?toolCallId=${encodeURIComponent(toolCallId)}`
  );

/**
 * 把会话切到以 messageId 为"位置"那条分支的叶子(下探到分支末端)。
 * 返回切换后的激活链,前端直接替换。
 */
export const switchVersion = async (
  messageId: string
): Promise<readonly ThreadMessage[]> =>
  apiFetch<readonly ThreadMessage[]>(`/api/v1/messages/${messageId}/switch-version`, {
    method: "POST"
  });

export interface PendingApproval {
  readonly callId: string;
  readonly runId?: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** T14:本次调用的风险画像(服务端算,SSE 与刷新两条路径一致)。 */
  readonly risk: ToolRisk;
}

interface ListApprovalsResponse {
  readonly approvals: readonly PendingApproval[];
}

/** 拉取指定会话当前待审批的危险工具请求。 */
export const listApprovals = async (
  sessionId: string
): Promise<readonly PendingApproval[]> => {
  const data = await apiFetch<ListApprovalsResponse>(
    `/api/v1/tool-approvals?sessionId=${encodeURIComponent(sessionId)}`
  );
  return data.approvals;
};

/** 提交决定: allow=true 批准执行, false 拒绝。 */
export const decideApproval = async (
  callId: string,
  allowed: boolean
): Promise<void> => {
  await apiFetch(`/api/v1/tool-approvals/${callId}`, {
    method: "POST",
    body: JSON.stringify({ allowed })
  });
};

/**
 * T31:「始终允许」→ 后端选精确 policy key 落 allowAlwaysPolicies。
 * key 生成在后端(buildPolicyKeys 单一事实来源),前端只传 {tool, sessionId, args}。
 * 返回 null = 不可记忆(destructive / 未知工具),前端别弹「已加入」。
 */
export const grantApprovalPolicy = async (
  tool: string,
  sessionId: string,
  args: Record<string, unknown>
): Promise<string | null> => {
  const data = await apiFetch<{ key: string | null }>(
    "/api/v1/approval-policies/grant",
    { method: "POST", body: JSON.stringify({ tool, sessionId, args }) }
  );
  return data.key;
};