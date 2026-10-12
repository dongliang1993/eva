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
 * run-scoped plan gate 状态。enter/exit 工具在 execute 里改它,
 * server 的 canUseTool 每次调用读它 —— 不是 build 期快照。
 */
export interface PlanGateState {
  current(): PlanGateSnapshot;
  enter(handle: PlanGateHandle): void;
  exit(): void;
}

const INACTIVE: PlanGateSnapshot = { active: false };

export const createPlanGateState = (
  initial: PlanGateSnapshot = INACTIVE,
): PlanGateState => {
  let current: PlanGateSnapshot = initial.active ? initial : INACTIVE;

  return {
    current: () => current,
    enter: (handle) => {
      current = { active: true, ...handle };
    },
    exit: () => {
      current = INACTIVE;
    },
  };
};


