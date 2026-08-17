import { apiFetch } from "./fetch";

export interface PendingApproval {
  readonly callId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

interface ListApprovalsResponse {
  readonly approvals: readonly PendingApproval[];
}

/** 拉取当前待审批的危险工具请求。 */
export const listApprovals = async (): Promise<readonly PendingApproval[]> => {
  const data = await apiFetch<ListApprovalsResponse>("/api/tool-approvals");
  return data.approvals;
};

/** 提交决定: allow=true 批准执行, false 拒绝。 */
export const decideApproval = async (
  callId: string,
  allowed: boolean
): Promise<void> => {
  await apiFetch(`/api/tool-approvals/${callId}`, {
    method: "POST",
    body: JSON.stringify({ allowed })
  });
};