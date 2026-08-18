import { apiFetch } from "../../shared/api/fetch";

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