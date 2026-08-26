import path from "node:path";

import type { AgentTool } from "../build-tool.js";
import type { PlanGateState } from "./state.js";

const HARD_BLOCKED_TOOLS = new Set(["TaskStop", "CronCreate", "CronDelete"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

const normalizeInputPath = (input: string): string =>
  input.replace(/^\.\/+/, "");

const isPlanPath = (
  input: string,
  planPath: string,
  planRelPath: string,
): boolean => {
  const normalized = normalizeInputPath(input);
  if (normalized === planRelPath || normalized === normalizeInputPath(planRelPath)) {
    return true;
  }
  if (path.isAbsolute(input)) {
    return path.resolve(input) === path.resolve(planPath);
  }
  return false;
};

/** 与闸门/免弹窗短路共用的同一份路径判定（契约:planPath 单一事实源）。 */
export const matchesPlanGatePath = (
  input: string,
  snapshot: { readonly planPath?: string; readonly planRelPath?: string },
): boolean =>
  snapshot.planPath !== undefined &&
  snapshot.planRelPath !== undefined &&
  isPlanPath(input, snapshot.planPath, snapshot.planRelPath);

export const planGateDeniedMessage = (planPath: string | undefined): string =>
  `[Plan Mode] Only read-only tools and the current plan file are available. ` +
  `Write the plan to ${planPath ?? "(no plan file)"}, then call exit_plan_mode.`;

/**
 * T45a:plan gate 是最外层闸门(执行序:planGate → approval → cap)。
 * 它只回答「挡不挡」：硬挡 write/edit 到非 plan 路径与 TaskStop/Cron*;
 * 免不免审批是 requestApproval 闭包的事,这里不认识审批通道。
 */
export const withPlanGate = (
  agentTool: AgentTool,
  state: PlanGateState,
): AgentTool => {
  const inner = agentTool.tool;
  const innerExecute = inner.execute;

  if (typeof innerExecute !== "function") {
    return agentTool;
  }

  return {
    ...agentTool,
    tool: {
      ...inner,
      execute: async (input: unknown, options?: unknown) => {
        const snap = state.current();
        if (!snap.active) {
          return innerExecute(input as never, options as never);
        }

        if (HARD_BLOCKED_TOOLS.has(agentTool.name)) {
          return planGateDeniedMessage(snap.planPath);
        }

        if (WRITE_TOOLS.has(agentTool.name)) {
          const target = (input as Record<string, unknown> | undefined)?.path;
          const ok =
            typeof target === "string" &&
            snap.planPath !== undefined &&
            snap.planRelPath !== undefined &&
            isPlanPath(target, snap.planPath, snap.planRelPath);
          if (!ok) {
            return planGateDeniedMessage(snap.planPath);
          }
        }

        return innerExecute(input as never, options as never);
      },
    } as typeof inner,
  };
};
