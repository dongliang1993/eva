import { useCallback, useEffect, useState } from "react";

import type { RunApprovalRequestEvent, RunApprovalResolvedEvent } from "@eva/shared";

import { decideApproval, listApprovals, type PendingApproval } from "../api/approvals";

/**
 * 待审批的危险工具请求。
 *
 * 事实源是 SSE 的 approval_request / approval_resolved 事件(T0.4)。
 * 挂载时拉一次 listApprovals() 只为覆盖「页面刷新时正好有 run 在等审批」
 * 这一种情况 —— 不再轮询。
 */
export function useApprovals(alwaysAllowEnabled?: () => Promise<void> | void) {
  const [pending, setPending] = useState<readonly PendingApproval[]>([]);

  // 挂载时对齐一次(断线重连/刷新恢复)
  useEffect(() => {
    listApprovals()
      .then(setPending)
      .catch(() => {
        // 拉取失败静默:刷新前已通过 SSE 建立的 pending 仍可用
      });
  }, []);

  const decide = useCallback(async (callId: string, allowed: boolean) => {
    await decideApproval(callId, allowed);
    setPending((prev) => prev.filter((p) => p.callId !== callId));
  }, []);

  /** 允许执行,并把「始终允许」落到 autoApprove。 */
  const allowAlways = useCallback(
    async (callId: string) => {
      await alwaysAllowEnabled?.();
      await decide(callId, true);
    },
    [alwaysAllowEnabled, decide]
  );

  /** 由 useChat 的 onApproval 回调驱动(SSE approval_request / approval_resolved)。 */
  const applyStreamEvent = useCallback(
    (event: RunApprovalRequestEvent | RunApprovalResolvedEvent) => {
      setPending((prev) =>
        event.type === "approval_request"
          ? [...prev, { callId: event.callId, tool: event.toolName, args: event.args }]
          : prev.filter((item) => item.callId !== event.callId)
      );
    },
    []
  );

  return { pending, decide, allowAlways, applyStreamEvent };
}