import { apiFetch } from "../../shared/api/fetch";
import type { ThreadMessage, ThreadStatus, ThreadUsage } from "../../types/api";

export const fetchThreadStatus = async (threadId: string): Promise<ThreadStatus> =>
  apiFetch<ThreadStatus>(`/api/v1/threads/${threadId}/status`);

export const fetchThreadUsage = async (threadId: string): Promise<ThreadUsage> =>
  apiFetch<ThreadUsage>(`/api/v1/threads/${threadId}/usage`);

/** 拉取该会话激活链上的全部消息(含 siblingIds 版本信息)。 */
export const fetchThreadMessages = async (
  threadId: string
): Promise<readonly ThreadMessage[]> =>
  apiFetch<readonly ThreadMessage[]>(`/api/v1/threads/${threadId}/messages`);

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