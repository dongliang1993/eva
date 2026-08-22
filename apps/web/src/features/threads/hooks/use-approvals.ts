import { useCallback, useState } from "react";

import type {
  ApprovalDecision,
  RunApprovalRequestEvent,
  RunApprovalResolvedEvent
} from "@eva/shared";

import { decideApproval, listApprovals, type PendingApproval } from "../api";

/**
 * 待审批的危险工具请求。
 *
 * 事实源是 SSE 的 approval_request / approval_resolved 事件(T0.4)。
 * `refresh(sessionId)` 只覆盖「页面刷新时正好有 run 在等审批」这一种
 * 情况 —— 会话切换/刷新时由 chat-page 用 effect 驱动,不轮询。
 *
 * T30:决策后不再即删,而是把这条从 pending 移入 resolved(定格态)。
 * 刷新恢复的事实源是消息 part 的 toolMetadata.approvalDecision,不是这里。
 */
export function useApprovals(
  allowAlwaysEnabled?: (tool: string, args: Record<string, unknown>) => Promise<void> | void
) {
  const [pending, setPending] = useState<readonly PendingApproval[]>([]);
  /** 本次会话内刚决策的定格态(callId → 决策)。只覆盖「在看的这一张」。 */
  const [resolved, setResolved] = useState<Readonly<Record<string, ApprovalDecision>>>({});

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

  /** T31:「始终允许」→ 落 thread 作用域 policy key(不再是全局 per-tool 白名单)。 */
  const allowAlways = useCallback(
    async (callId: string) => {
      const target = pending.find((p) => p.callId === callId);
      if (target) {
        await allowAlwaysEnabled?.(target.tool, target.args);
      }
      await decide(callId, true);
    },
    [pending, allowAlwaysEnabled, decide]
  );

  /** 由 useChat 的 onApproval 回调驱动(SSE approval_request / approval_resolved)。 */
  const applyStreamEvent = useCallback(
    (event: RunApprovalRequestEvent | RunApprovalResolvedEvent) => {
      if (event.type === "approval_request") {
        setPending((prev) => [
          ...prev,
          { callId: event.callId, tool: event.toolName, args: event.args, risk: event.risk }
        ]);
        return;
      }

      // T30:决策后从 pending 摘出、记入 resolved —— 卡片定格成「已允许/已拒绝 · 时间」,
      // 不再凭空消失。decide() 的本地 filter 与这一帧并发无碍(幂等移除)。
      setPending((prev) => prev.filter((item) => item.callId !== event.callId));
      setResolved((prev) => ({ ...prev, [event.callId]: event.decision }));
    },
    []
  );

  return { pending, resolved, decide, allowAlways, applyStreamEvent, refresh };
}