import { useCallback, useState } from "react";

import type {
  ApprovalDecision,
  PlanReviewDecision,
  RunApprovalRequestEvent,
  RunApprovalResolvedEvent,
  RunPlanReviewRequestEvent,
  RunPlanReviewResolvedEvent
} from "@eva/shared";

import {
  decideApproval,
  decidePlanReview as decidePlanReviewApi,
  listApprovals,
  type PendingApproval,
  type PendingPlanReview,
  type PlanReviewClientOutcome
} from "../api";

type ApprovalStreamEvent =
  | RunApprovalRequestEvent
  | RunApprovalResolvedEvent
  | RunPlanReviewRequestEvent
  | RunPlanReviewResolvedEvent;

/**
 * 待审批的危险工具请求 + T45b plan review 请求。
 *
 * 事实源是 SSE 的 approval_request / approval_resolved / plan_review_request / plan_review_resolved。
 * `refresh(sessionId)` 只覆盖普通工具的刷新恢复;plan review 的定格事实源是消息 part 的
 * toolMetadata.planReviewDecision。
 */
export function useApprovals(
  allowAlwaysEnabled?: (tool: string, args: Record<string, unknown>) => Promise<void> | void
) {
  const [pending, setPending] = useState<readonly PendingApproval[]>([]);
  /** 本次会话内刚决策的定格态(callId → 决策)。只覆盖「在看的这一张」。 */
  const [resolved, setResolved] = useState<Readonly<Record<string, ApprovalDecision>>>({});
  const [pendingPlanReviews, setPendingPlanReviews] = useState<readonly PendingPlanReview[]>([]);
  const [resolvedPlanReviews, setResolvedPlanReviews] = useState<
    Readonly<Record<string, PlanReviewDecision>>
  >({});

  /** 会话切换/刷新恢复时对齐一次(不轮询) —— 事实源仍是 SSE 事件。 */
  const refresh = useCallback((sessionId: string | null) => {
    if (!sessionId) {
      setPending([]);
      setPendingPlanReviews([]);
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

  /** T45b:plan review 决策。dismissed 没有前端入口。 */
  const decidePlanReview = useCallback(
    async (
      callId: string,
      outcome: PlanReviewClientOutcome,
      payload: { feedback?: string; selectedLabel?: string } = {}
    ) => {
      await decidePlanReviewApi(callId, { outcome, ...payload });
      setPendingPlanReviews((prev) => prev.filter((p) => p.callId !== callId));
    },
    []
  );

  /** 由 useChat 的 onApproval 回调驱动。 */
  const applyStreamEvent = useCallback((event: ApprovalStreamEvent) => {
    if (event.type === "approval_request") {
      setPending((prev) => [
        ...prev,
        { callId: event.callId, tool: event.toolName, args: event.args, risk: event.risk }
      ]);
      return;
    }

    if (event.type === "approval_resolved") {
      setPending((prev) => prev.filter((item) => item.callId !== event.callId));
      setResolved((prev) => ({ ...prev, [event.callId]: event.decision }));
      return;
    }

    if (event.type === "plan_review_request") {
      setPendingPlanReviews((prev) => [
        ...prev.filter((item) => item.callId !== event.callId),
        {
          callId: event.callId,
          planId: event.planId,
          planPath: event.planPath,
          planMarkdown: event.planMarkdown,
          ...(event.options !== undefined ? { options: event.options } : {}),
          revision: event.revision
        }
      ]);
      return;
    }

    // plan_review_resolved:定格,不再凭空消失。
    setPendingPlanReviews((prev) => prev.filter((item) => item.callId !== event.callId));
    setResolvedPlanReviews((prev) => ({ ...prev, [event.callId]: event.decision }));
  }, []);

  return {
    pending,
    resolved,
    pendingPlanReviews,
    resolvedPlanReviews,
    decide,
    decidePlanReview,
    allowAlways,
    applyStreamEvent,
    refresh
  };
}
