import { classifyToolRisk } from "@eva/harness";
import type { PlanReviewDecision, ToolRisk } from "@eva/shared";

import {
  ApprovalRepository,
  type ApprovalKind,
  type ApprovalRequestRow
} from "./approval-repository.js";

interface PendingRequest {
  readonly runId: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly kind: ApprovalKind;
  readonly args: unknown;
  /** T14:ask 时即时算一次,SSE 与 listApprovals 两条路径共用这份画像。 */
  readonly risk: ToolRisk;
  resolve: (decision: boolean | PlanReviewDecision) => void;
}

/** 一次审批请求的归属与内容。 */
export interface ApprovalAskInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly args: unknown;
}

export interface PendingApprovalView {
  readonly callId: string;
  readonly runId: string;
  readonly tool: string;
  readonly args: unknown;
  /** T14:风险画像,SSE 事件里的 risk 与这里一致。 */
  readonly risk: ToolRisk;
}

const planReviewStatusFor = (
  outcome: PlanReviewDecision["outcome"]
): "granted" | "denied" | "revise" | "reject_and_exit" | "dismissed" => {
  switch (outcome) {
    case "approve":
      return "granted";
    case "reject":
      return "denied";
    case "revise":
      return "revise";
    case "reject_and_exit":
      return "reject_and_exit";
    case "dismissed":
      return "dismissed";
  }
};

/**
 * 审批网关 —— 危险工具执行前的闸门。
 *
 * 普通工具继续只认 boolean;T45b 的 plan review 走平行通道(askPlanReview)。
 * **审批永远等人,不超时。** 出口只有三个:decide / cancelByRun / 进程重启清扫。
 */
export class ApprovalGateway {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly repo: ApprovalRepository) {}

  /** 子代理/短路的自动通过分支。落库即 granted,返回 true;不进 pending Map。 */
  autoApprove(callId: string, input: ApprovalAskInput, reason?: string): boolean {
    this.repo.create({ id: callId, ...input });
    this.repo.decide(callId, "granted", reason);
    return true;
  }

  /** 发起一次普通工具审批请求,返回解析为「是否允许」的 Promise。 */
  ask(callId: string, input: ApprovalAskInput): Promise<boolean> {
    this.repo.create({ id: callId, ...input, kind: "tool" });

    return new Promise<boolean>((resolve) => {
      this.pending.set(callId, {
        ...input,
        kind: "tool",
        risk: classifyToolRisk(input.tool, (input.args ?? {}) as Record<string, unknown>),
        resolve: (decision) => resolve(decision === true)
      });
    });
  }

  /** T45b:plan review 平行通道。返回结构化决策;普通 boolean 协议不认识这条路。 */
  askPlanReview(callId: string, input: ApprovalAskInput): Promise<PlanReviewDecision> {
    this.repo.create({ id: callId, ...input, kind: "plan_review" });

    return new Promise<PlanReviewDecision>((resolve) => {
      this.pending.set(callId, {
        ...input,
        kind: "plan_review",
        risk: classifyToolRisk(input.tool, (input.args ?? {}) as Record<string, unknown>),
        resolve: (decision) => resolve(decision as PlanReviewDecision)
      });
    });
  }

  /** 按 callId 查台账行(T30:决策回写/approval_resolved 帧的数据源)。 */
  getRequest(callId: string): ApprovalRequestRow | undefined {
    return this.repo.getById(callId);
  }

  /** 普通工具决策。plan_review pending 不走这条,返回 false。 */
  decide(callId: string, allowed: boolean): boolean {
    const entry = this.pending.get(callId);
    if (!entry || entry.kind !== "tool") return false;

    this.pending.delete(callId);
    this.repo.decide(callId, allowed ? "granted" : "denied");
    entry.resolve(allowed);
    return true;
  }

  /** plan review 决策。decision 不带 decidedAt 也可以,这里统一补。 */
  decidePlanReview(
    callId: string,
    decision: Omit<PlanReviewDecision, "decidedAt"> & { decidedAt?: string }
  ): boolean {
    const entry = this.pending.get(callId);
    if (!entry || entry.kind !== "plan_review") return false;
    if (decision.outcome === "revise" && !(decision.feedback ?? "").trim()) return false;

    if (decision.outcome === "approve" && decision.selectedLabel !== undefined) {
      const options = (entry.args as { options?: readonly { label: string }[] } | undefined)
        ?.options;
      if (options && !options.some((option) => option.label === decision.selectedLabel)) {
        return false;
      }
    }

    const full: PlanReviewDecision = {
      ...decision,
      decidedAt: decision.decidedAt ?? new Date().toISOString()
    } as PlanReviewDecision;

    this.pending.delete(callId);
    this.repo.decidePlanReview(
      callId,
      planReviewStatusFor(full.outcome),
      JSON.stringify(full)
    );
    entry.resolve(full);
    return true;
  }

  /**
   * 取消某次 run 下所有未决审批。按 kind 分流(契约 6):
   * tool → denied + resolve(false);plan_review → dismissed + resolve({outcome:"dismissed"})。
   */
  cancelByRun(runId: string): number {
    let cancelled = 0;

    for (const [callId, entry] of [...this.pending]) {
      if (entry.runId !== runId) {
        continue;
      }
      this.pending.delete(callId);

      if (entry.kind === "plan_review") {
        const decision: PlanReviewDecision = {
          outcome: "dismissed",
          decidedAt: new Date().toISOString()
        };
        this.repo.decidePlanReview(callId, "dismissed", JSON.stringify(decision));
        entry.resolve(decision);
      } else {
        this.repo.decide(callId, "denied");
        entry.resolve(false);
      }
      cancelled += 1;
    }

    return cancelled;
  }

  /** 当前未决的普通工具审批(供前端 SSE/轮询恢复;plan review 有自己的帧)。 */
  listPending(sessionId?: string): readonly PendingApprovalView[] {
    const out: PendingApprovalView[] = [];
    for (const [callId, entry] of this.pending) {
      if (entry.kind !== "tool") continue;
      if (sessionId && entry.sessionId !== sessionId) continue;
      out.push({
        callId,
        runId: entry.runId,
        tool: entry.tool,
        args: entry.args,
        risk: entry.risk
      });
    }
    return out;
  }
}
