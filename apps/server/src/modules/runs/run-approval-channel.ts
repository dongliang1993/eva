import {
  classifyToolRisk,
  isSafeReadOnlyCommand,
  matchesPlanGatePath,
  type PlanGateState,
  type RequestApproval,
  type RequestPlanReview
} from "@eva/harness";
import type { ApprovalDecision, PlanReviewDecision, RunStreamEvent } from "@eva/shared";

import type {
  ApprovalGateway,
  ApprovalPolicyStore,
} from "../approvals/index.js";

export interface RunApprovalChannelDependencies {
  readonly approvals: ApprovalGateway;
  readonly approvalPolicies: ApprovalPolicyStore;
  readonly runId: string;
  readonly sessionId: string;
  /** 帧出口 —— 传 hub.publish,不是直写某条连接(重连上来的订阅者也要收到审批卡片)。 */
  readonly emit: (event: RunStreamEvent) => void;
}

/**
 * 一次 Run 的审批通道 —— 工具执行前那道闸门的**全部**决定都在这个文件里。
 *
 * 三条出口,不是三个相似的函数:
 * - `requestApproval`      主 Agent 的普通工具:四级放行链,最后一级才弹窗;
 * - `subagentRequestApproval` 后台子代理:没人能点弹窗,直接落台账自动通过;
 * - `requestPlanReview`    exit_plan_mode 的平行通道(不走 boolean 协议)。
 *
 * 外加两个 `lookup*Decision` —— 决策的**唯一查询口**。事实源是 `approval_requests` 行,
 * 不是 SSE 事件:回放路径不带 decision(§坑 3),从事件里捞会在刷新后丢掉定格态。
 */
export class RunApprovalChannel {
  /**
   * T45a:plan gate 的 run-scoped 状态,由 `bindPlanGate` 在装配期补上。
   *
   * 为什么是 bind 而不是构造参数:装配顺序上有一个环 —— plan gate 要拿
   * `requestPlanReview` 才能建,而 `requestApproval` 要读 plan gate 的 state。
   * 断这个环的地方就是这里:通道先建好(它不需要 state 就能交出闭包),
   * state 建好后回填同一个引用。注意是**引用**:enter/exit 工具在运行期改的是
   * 同一个对象,通道每次都读 `current()` 拿最新快照,不是 build 期的副本。
   */
  private planGateState: PlanGateState | undefined;

  constructor(private readonly deps: RunApprovalChannelDependencies) {}

  bindPlanGate(state: PlanGateState): void {
    this.planGateState = state;
  }

  /** 归属信息:每次落台账都要带,抽出来免得四处重复。 */
  private origin(tool: string, args: unknown) {
    return {
      runId: this.deps.runId,
      sessionId: this.deps.sessionId,
      tool,
      args
    };
  }

  /**
   * T30:审批决策的唯一查询口 —— finish 落库回写与 approval_resolved 帧共用。
   * 事实源是 approval_requests 行,不是 SSE 事件(§坑 3:回放路径不带 decision)。
   */
  readonly lookupApprovalDecision = (callId: string): ApprovalDecision | undefined => {
    const row = this.deps.approvals.getRequest(callId);
    if (!row || (row.status !== "granted" && row.status !== "denied") || !row.decidedAt) {
      return undefined;
    }
    return { action: row.status, decidedAt: row.decidedAt };
  };

  /** T45b:plan review 定格/刷新重建的事实源 —— approval_requests.kind + decision JSON。 */
  readonly lookupPlanReviewDecision = (callId: string): PlanReviewDecision | undefined => {
    const row = this.deps.approvals.getRequest(callId);
    if (!row || row.kind !== "plan_review" || !row.decidedAt || !row.decision) {
      return undefined;
    }
    try {
      return JSON.parse(row.decision) as PlanReviewDecision;
    } catch {
      return undefined;
    }
  };

  /**
   * 主 Agent 的工具闸门。
   *
   * **四级放行链的顺序是产品行为,不是实现细节** —— 改动顺序会改变用户看到什么:
   *   ① bash 只读直放 → ② plan 文件写直放 → ③ policy 记忆命中 → ④ 才弹窗。
   * 每一级为什么在这个位置,见各自的注释。
   */
  readonly requestApproval: RequestApproval = async ({ toolCallId, toolName, args }) => {
    // ① T29:bash 只读命令直放落台账。harness 的 withApproval 已短路(requestApproval
    // 根本不被调),所以「没弹窗但执行了」要在这里补一笔 —— 与 harness 共用同一个
    // isSafeReadOnlyCommand,判定不漂移(r7 §3 契约 2)。
    if (
      toolName === "bash" &&
      isSafeReadOnlyCommand(String((args as Record<string, unknown>)?.command ?? ""))
    ) {
      this.deps.approvals.autoApprove(
        toolCallId,
        this.origin(toolName, args),
        "readonly-safe"
      );
      return true;
    }

    // ② T45a:plan 文件写免弹窗。判定与 withPlanGate 共用 matchesPlanGatePath 和同一份
    // planGateState —— planPath 单一事实源,不各自解析。漏掉这条的后果:用户被弹烦了点
    // 「始终允许」,write 的 policy key 是 write:thread:<id>:all,该会话此后所有写全免。
    const planSnap = this.planGateState?.current();
    if (
      planSnap?.active === true &&
      (toolName === "write" || toolName === "edit") &&
      typeof (args as Record<string, unknown>)?.path === "string" &&
      matchesPlanGatePath((args as Record<string, unknown>).path as string, planSnap)
    ) {
      this.deps.approvals.autoApprove(toolCallId, this.origin(toolName, args), "plan-file");
      return true;
    }

    const risk = classifyToolRisk(toolName, args);

    // ③ T28:policy 记忆短路(Alma 放行链第 2 级)。必须在 emit approval_request 之前 ——
    // 放进 ask 内部会让「没问过人」的卡片在前端闪一帧。命中 = 台账 granted + 直放。
    const policyHit = this.deps.approvalPolicies.match(toolName, this.deps.sessionId, args);
    if (policyHit) {
      this.deps.approvals.autoApprove(
        toolCallId,
        this.origin(toolName, args),
        `policy:${policyHit}`
      );
      return true;
    }

    // ④ 弹窗。ask 永远等人,不超时。
    this.deps.emit({ type: "approval_request", callId: toolCallId, toolName, args, risk });
    const approved = await this.deps.approvals.ask(toolCallId, this.origin(toolName, args));
    // T30:ask 返回时行已 decided —— 从台账查回 decision 附进帧,前端定格态用。
    this.deps.emit({
      type: "approval_resolved",
      callId: toolCallId,
      approved,
      decision: this.lookupApprovalDecision(toolCallId) ?? {
        action: approved ? "granted" : "denied",
        decidedAt: new Date().toISOString()
      }
    });

    return approved;
  };

  /**
   * 子代理分支(T17,docs 04 §8.6.1):后台子代理没人能点弹窗 —— 进闸门、
   * 自动通过、落台账。不发 approval_request:后台的 SSE 帧混进主流会让前端
   * 冒出 runId 相同但 toolCallId 陌生的审批卡片。
   */
  readonly subagentRequestApproval: RequestApproval = async ({ toolCallId, toolName, args }) =>
    this.deps.approvals.autoApprove(toolCallId, this.origin(toolName, args));

  /** T45b:exit_plan_mode 的平行审批通道。普通工具的 RequestApproval boolean 链路不动。 */
  readonly requestPlanReview: RequestPlanReview = async ({
    toolCallId,
    planId,
    planPath,
    content,
    revision,
    options
  }) => {
    this.deps.emit({
      type: "plan_review_request",
      callId: toolCallId,
      planId,
      planPath,
      planMarkdown: content,
      ...(options !== undefined ? { options } : {}),
      revision
    });

    const decision = await this.deps.approvals.askPlanReview(
      toolCallId,
      this.origin("exit_plan_mode", {
        planId,
        planPath,
        revision,
        ...(options !== undefined ? { options } : {})
      })
    );

    this.deps.emit({ type: "plan_review_resolved", callId: toolCallId, decision });
    return decision;
  };
}
