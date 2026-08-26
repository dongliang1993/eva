import type { SystemModelMessage } from "ai";

import type { PlanGateSnapshot } from "./state.js";

/**
 * T45a:每步注入的 plan reminder。plan 路径不能只活在 enter_plan_mode 的
 * tool result 里 —— 那条消息会被 tool-result budget / compact 折走。
 */
export const planGateInstructions = (
  snap: PlanGateSnapshot,
): SystemModelMessage[] => {
  if (!snap.active || !snap.planPath) return [];

  return [
    {
      role: "system",
      content:
        `Plan mode is active. Plan file: ${snap.planPath}. ` +
        "Direct file writes are limited to this plan file; use write/edit only on it. " +
        "When the plan is ready, call exit_plan_mode for approval.",
    },
  ];
};
