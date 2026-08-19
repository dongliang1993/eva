import { useCallback, useState } from "react";

import type { RunApprovalRequestEvent, RunApprovalResolvedEvent } from "@eva/shared";

import { decideApproval, listApprovals, type PendingApproval } from "../api";

/**
 * 待审批的危险工具请求。
 *
 * 事实源是 SSE 的 approval_request / approval_resolved 事件(T0.4)。
 * `refresh(sessionId)` 只覆盖「页面刷新时正好有 run 在等审批」这一种
 * 情况 —— 会话切换/刷新时由 chat-page 用 effect 驱动,不轮询。
 */
export function useApprovals(
  allowAlwaysEnabled?: (toolName: string) => Promise<void> | void
) {
  const [pending, setPending] = useState<readonly PendingApproval[]>([]);

  /** 会话切换/刷新恢复时对齐一次(不轮询) —— 事实源仍是 SSE 事件。 */
  const refresh = useCallback((sessionId: string | null) => {
    if (!sessionId) {
      setPending([]);
      return;
    }

    let stale = false;

    listApprovals(sessionId)
      .then((next) => {
        if (!stale) setPending(next);
      })
      .catch(() => {
        // 拉取失败静默:此前通过 SSE 建立的 pending 仍可用
      });

    return () => {
      stale = true;
    };
  }, []);

  const decide = useCallback(async (callId: string, allowed: boolean) => {
    await decideApproval(callId, allowed);
    setPending((prev) => prev.filter((p) => p.callId !== callId));
  }, []);

  /** 允许执行,并把「始终允许」落到 per-tool 白名单(T14)。 */
  const allowAlways = useCallback(
    async (callId: string) => {
      const target = pending.find((p) => p.callId === callId);
      if (target) {
        await allowAlwaysEnabled?.(target.tool);
      }
      await decide(callId, true);
    },
    [pending, allowAlwaysEnabled, decide]
  );

  /** 由 useChat 的 onApproval 回调驱动(SSE approval_request / approval_resolved)。 */
  const applyStreamEvent = useCallback(
    (event: RunApprovalRequestEvent | RunApprovalResolvedEvent) => {
      setPending((prev) =>
        event.type === "approval_request"
          ? [
            ...prev,
            { callId: event.callId, tool: event.toolName, args: event.args, risk: event.risk }
          ]
          : prev.filter((item) => item.callId !== event.callId)
      );
    },
    []
  );

  return { pending, decide, allowAlways, applyStreamEvent, refresh };
}