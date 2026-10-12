import type {
  CanUseTool,
  PermissionResult,
  PlanGateState,
  PlanGateStore,
} from "@eva/harness";
import type {
  ApprovalDecision,
  PlanReviewDecision,
  PlanReviewOptionView,
  RunStreamEvent,
} from "@eva/shared";

import type {
  ApprovalGateway,
  ApprovalPolicyStore,
} from "../approvals/index.js";
import {
  buildPolicyKeys,
  classifyToolRisk,
  isSafeReadOnlyCommand,
  matchesPlanGatePath,
  planGateDeniedMessage,
} from "./tool-policy.js";

export interface RunPermissionsDependencies {
  readonly approvals: ApprovalGateway;
  readonly approvalPolicies: ApprovalPolicyStore;
  readonly runId: string;
  readonly sessionId: string;
  readonly toolUseIdPrefix?: string;
  /** 帧出口 —— 传 hub.publish,不是直写某条连接(重连上来的订阅者也要收到审批卡片)。 */
  readonly emit: (event: RunStreamEvent) => void;
  /** plan gate 状态与 store;无 workspace 的 run 不带。 */
  readonly planGate?:
    | {
        readonly state: PlanGateState;
        readonly store: PlanGateStore;
      }
    | undefined;
}

/** 决策的**唯一查询口**。事实源是 `approval_requests` 行,不是 SSE 事件。 */
export interface RunPermissions {
  readonly canUseTool: CanUseTool;
  readonly lookupApprovalDecision: (callId: string) => ApprovalDecision | undefined;
  readonly lookupPlanReviewDecision: (callId: string) => PlanReviewDecision | undefined;
  /** 供 agent 装配 enter/exit 工具用(同一个引用,canUseTool 读它判 plan 文件写)。 */
  readonly planGate:
    | { readonly state: PlanGateState; readonly store: PlanGateStore }
    | undefined;
}

/** 归属信息:每次落台账都要带,抽出来免得四处重复。 */
const origin = (deps: RunPermissionsDependencies, tool: string, args: unknown) => ({
  runId: deps.runId,
  sessionId: deps.sessionId,
  tool,
  args,
});

/**
 * plan review 的前置校验(plan 未激活 / plan 文件为空)。
 *
 * execute 里也有一份兜底,但 server 必须在发审批帧**之前**做同样的检查并直接
 * deny —— 不能为一个空 plan 弹审批卡。两处共用这一个函数。
 */
const planReviewPrecondition = async (
  state: PlanGateState,
  store: PlanGateStore,
): Promise<
  | { readonly ok: true; readonly handle: { planId: string; planPath: string; planRelPath: string }; readonly content: string }
  | { readonly ok: false; readonly deny: PermissionResult }
> => {
  const snap = state.current();
  const handle =
    snap.active && snap.planId && snap.planPath && snap.planRelPath
      ? {
          planId: snap.planId,
          planPath: snap.planPath,
          planRelPath: snap.planRelPath,
        }
      : undefined;
  if (!handle) {
    return {
      ok: false,
      deny: {
        behavior: "deny",
        message: "Error: exit_plan_mode can only be called while plan mode is active.",
        isError: true,
      },
    };
  }
  const content = await store.readPlan(handle);
  if (content.trim().length === 0) {
    return {
      ok: false,
      deny: {
        behavior: "deny",
        message:
          `Error: No plan content found. Write your plan to ${handle.planPath} first, then call exit_plan_mode.`,
        isError: true,
      },
    };
  }
  return { ok: true, handle, content };
};

/**
 * 一次 Run 的权限链 —— 工具执行前那道闸门的**全部**决定都在这个文件里。
 *
 * 放行链顺序是产品行为,不是实现细节 —— 改动顺序会改变用户看到什么:
 *   ① plan gate 拦写(非 plan 路径的 write/edit)
 *   ② exit_plan_mode → plan review
 *   ③ bash 只读直放
 *   ④ plan 文件写直放
 *   ⑤ always-allow 命中
 *   ⑥ 发 approval_request → 等人 → 发 approval_resolved
 *
 * 每一级为什么在这个位置,见各自的注释。
 */
export const createRunPermissions = (
  deps: RunPermissionsDependencies,
): RunPermissions => {
  /**
   * ① plan gate 拦写。今天的 withPlanGate:plan 激活时,write/edit 只放 plan 文件,
   * 其余一律 `[Plan Mode] …` 文案拒绝。它必须是第一级 —— 用户在 plan mode 里
   * 拒绝过一次写,不应该再为同一个文件弹审批卡。
   */
  const denyIfPlanGateBlocks = (
    toolName: string,
    input: Record<string, unknown>,
  ): PermissionResult | undefined => {
    const planGate = deps.planGate;
    if (!planGate) return undefined;
    const snap = planGate.state.current();
    if (!snap.active) return undefined;
    if (toolName !== "write" && toolName !== "edit") return undefined;
    const target = input.path;
    const ok =
      typeof target === "string" &&
      matchesPlanGatePath(target, snap);
    if (ok) return undefined;
    return {
      behavior: "deny",
      message: planGateDeniedMessage(snap.planPath),
    };
  };

  /**
   * ② exit_plan_mode → plan review(平行通道)。五分支的文案逐字保留,
   * 与今天 createExitPlanModeTool 的 requestPlanReview 分支一致:
   *   approve → allow + updatedInput.decision(execute 落库解闸)
   *   revise → deny(不 interrupt)
   *   reject / reject_and_exit → deny + interrupt + isError
   *   dismissed → deny(不 interrupt)
   */
  const reviewPlan = async (
    toolUseID: string,
    options: readonly PlanReviewOptionView[] | undefined,
    handle: { planId: string; planPath: string },
    revision: number,
  ): Promise<PermissionResult> => {
    const decision = await deps.approvals.askPlanReview(
      toolUseID,
      origin(deps, "exit_plan_mode", {
        planId: handle.planId,
        planPath: handle.planPath,
        revision,
        ...(options !== undefined ? { options } : {}),
      }),
    );
    switch (decision.outcome) {
      case "approve":
        return {
          behavior: "allow",
          updatedInput: {
            decision: {
              outcome: "approve",
              selectedLabel: decision.selectedLabel,
              decidedAt: decision.decidedAt,
            },
          },
        };
      case "revise":
        return {
          behavior: "deny",
          message:
            `User rejected the plan. Feedback:\n\n${decision.feedback ?? ""}\n\nRevise the plan and call exit_plan_mode again.`,
        };
      case "reject":
        return {
          behavior: "deny",
          message:
            `Plan rejected. Plan mode remains active.${decision.feedback ? `\n\n${decision.feedback}` : ""}`,
          interrupt: true,
          isError: true,
        };
      case "reject_and_exit":
        return {
          behavior: "deny",
          message: "Plan rejected by user. Plan mode deactivated.",
          interrupt: true,
          isError: true,
        };
      case "dismissed":
        return {
          behavior: "deny",
          message: "Plan approval dismissed. Plan mode remains active.",
        };
    }
  };

  const canUseTool: CanUseTool = async (
    toolName,
    input,
    options,
  ): Promise<PermissionResult> => {
    // approval_asked / approval_decided 两种 run_events 由这里直接写
    // (它本来就知道 —— 这是唯一能同时看到问与答的地方)。
    const toolUseID = options.toolUseID;

    // ① plan gate 拦写(非 plan 路径)。
    const gateDeny = denyIfPlanGateBlocks(toolName, input);
    if (gateDeny !== undefined) {
      return gateDeny;
    }

    // ② exit_plan_mode:plan review 平行通道。前置校验先于审批帧(空 plan 不弹卡)。
    if (toolName === "exit_plan_mode" && deps.planGate) {
      const { state, store } = deps.planGate;
      const revision = await store.recordRevision({
        planId: state.current().planId ?? "",
        planPath: state.current().planPath ?? "",
        planRelPath: state.current().planRelPath ?? "",
      });
      const pre = await planReviewPrecondition(state, store);
      if (!pre.ok) {
        return pre.deny;
      }
      // 审批帧带上 plan 内容与选项。
      deps.emit({
        type: "plan_review_request",
        callId: toolUseID,
        planId: pre.handle.planId,
        planPath: pre.handle.planPath,
        planMarkdown: pre.content,
        revision,
        ...((input.options as PlanReviewOptionView[] | undefined) !== undefined
          ? { options: input.options as PlanReviewOptionView[] }
          : {}),
      });
      const result = await reviewPlan(
        toolUseID,
        input.options as readonly PlanReviewOptionView[] | undefined,
        pre.handle,
        revision,
      );
      deps.emit({ type: "plan_review_resolved", callId: toolUseID, decision: lookupPlanReviewDecisionOf(toolUseID)! });
      return result;
    }

    // ③ bash 只读直放:落台账(reason=readonly-safe),不弹窗。
    // 判定与 policy key 共用同一个 isSafeReadOnlyCommand,不会漂移。
    if (
      toolName === "bash" &&
      isSafeReadOnlyCommand(String(input.command ?? ""))
    ) {
      deps.approvals.autoApprove(
        toolUseID,
        origin(deps, toolName, input),
        "readonly-safe",
      );
      return { behavior: "allow" };
    }

    // ④ plan 文件写直放:planPath 单一事实源,不各自解析。
    // 漏掉这条的后果:用户被弹烦了点「始终允许」,write 的 policy key 是
    // write:thread:<id>:all,该会话此后所有写全免。
    const planSnap = deps.planGate?.state.current();
    if (
      planSnap?.active === true &&
      (toolName === "write" || toolName === "edit") &&
      typeof input.path === "string" &&
      matchesPlanGatePath(input.path, planSnap)
    ) {
      deps.approvals.autoApprove(
        toolUseID,
        origin(deps, toolName, input),
        "plan-file",
      );
      return { behavior: "allow" };
    }

    // ⑤ policy 记忆短路。必须在 emit approval_request 之前 ——
    // 放进 ask 内部会让「没问过人」的卡片在前端闪一帧。
    const policyHit = deps.approvalPolicies.match(
      toolName,
      deps.sessionId,
      input,
    );
    if (policyHit) {
      deps.approvals.autoApprove(
        toolUseID,
        origin(deps, toolName, input),
        `policy:${policyHit}`,
      );
      return { behavior: "allow" };
    }

    // ⑥ 弹窗。ask 永远等人,不超时。
    const risk = classifyToolRisk(toolName, input);
    deps.emit({ type: "approval_request", callId: toolUseID, toolName, args: input, risk });
    const approved = await deps.approvals.ask(
      toolUseID,
      origin(deps, toolName, input),
    );
    // ask 返回时行已 decided —— 从台账查回 decision 附进帧,前端定格态用。
    deps.emit({
      type: "approval_resolved",
      callId: toolUseID,
      approved,
      decision: lookupApprovalDecisionOf(toolUseID) ?? {
        action: approved ? "granted" : "denied",
        decidedAt: new Date().toISOString(),
      },
    });

    if (approved) {
      return { behavior: "allow" };
    }
    // 拒绝的文案与今天 withApproval 一致;status 仍为 success 的语义由
    // PermissionResult.isError=false 承担(前端靠 approvalDecision 显示「已拒绝」)。
    return {
      behavior: "deny",
      message:
        `[Approval Denied] The user rejected the \`${toolName}\` call. `
        + "Do not retry the same call. Explain what you wanted to do and ask the user how to proceed.",
    };
  };

  /** T30:审批决策的唯一查询口 —— finish 落库回写与 approval_resolved 帧共用。 */
  const lookupApprovalDecisionOf = (callId: string): ApprovalDecision | undefined => {
    const row = deps.approvals.getRequest(callId);
    if (!row || (row.status !== "granted" && row.status !== "denied") || !row.decidedAt) {
      return undefined;
    }
    return { action: row.status, decidedAt: row.decidedAt };
  };

  /** plan review 定格/刷新重建的事实源 —— approval_requests.kind + decision JSON。 */
  const lookupPlanReviewDecisionOf = (callId: string): PlanReviewDecision | undefined => {
    const row = deps.approvals.getRequest(callId);
    if (!row || row.kind !== "plan_review" || !row.decidedAt || !row.decision) {
      return undefined;
    }
    try {
      return JSON.parse(row.decision) as PlanReviewDecision;
    } catch {
      return undefined;
    }
  };

  return {
    canUseTool,
    lookupApprovalDecision: lookupApprovalDecisionOf,
    lookupPlanReviewDecision: lookupPlanReviewDecisionOf,
    planGate: deps.planGate,
  };
};
