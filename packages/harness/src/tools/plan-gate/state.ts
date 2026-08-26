import type {
  PlanReviewDecision,
  PlanReviewOptionView
} from "@eva/shared";

export interface PlanGateHandle {
  readonly planId: string;
  /** plan 文件绝对路径。 */
  readonly planPath: string;
  /** 相对 workspace root 的路径（write/edit 入参常用形态）。 */
  readonly planRelPath: string;
}

export interface PlanGateSnapshot {
  readonly active: boolean;
  readonly planId?: string;
  readonly planPath?: string;
  readonly planRelPath?: string;
}

/**
 * T45a:run-scoped plan gate 状态。enter/exit 工具在 execute 里改它,
 * withPlanGate 在每次 execute 读它 —— 不是 build 期快照。
 */
export interface PlanGateState {
  current(): PlanGateSnapshot;
  enter(handle: PlanGateHandle): void;
  exit(): void;
  /** T45b:reject / reject_and_exit 置位;run-scoped 一次性信号,不落库不跨 run。 */
  shouldStopTurn(): boolean;
  requestStopTurn(): void;
}

const INACTIVE: PlanGateSnapshot = { active: false };

export const createPlanGateState = (
  initial: PlanGateSnapshot = INACTIVE,
): PlanGateState => {
  let current: PlanGateSnapshot = initial.active ? initial : INACTIVE;
  let stopTurn = false;

  return {
    current: () => current,
    enter: (handle) => {
      current = { active: true, ...handle };
    },
    exit: () => {
      current = INACTIVE;
    },
    shouldStopTurn: () => stopTurn,
    requestStopTurn: () => {
      stopTurn = true;
    },
  };
};

/** T45b:exit_plan_mode 的平行审批通道。withApproval/普通工具 boolean 协议不认识它。 */
export interface PlanReviewRequestInput {
  readonly toolCallId: string;
  readonly planId: string;
  readonly planPath: string;
  readonly content: string;
  readonly revision: number;
  readonly options?: readonly PlanReviewOptionView[];
}

export type RequestPlanReview = (
  input: PlanReviewRequestInput,
) => Promise<PlanReviewDecision>;
