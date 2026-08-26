import { z } from "zod";

import { buildTool, type AgentTool } from "../build-tool.js";
import type {
  PlanGateHandle,
  PlanGateState,
  RequestPlanReview
} from "./state.js";

/** server 侧实现；harness 不认识 DB/文件系统细节。 */
export interface PlanGateStore {
  /** 建 plans 行 + 空 current.md。已有 active / 无 workspace 时抛错。 */
  enter(): Promise<PlanGateHandle>;
  readPlan(handle: PlanGateHandle): Promise<string>;
  /** 审批前定版:current.md → revisions/v<N>.md,返回 N。 */
  recordRevision(handle: PlanGateHandle): Promise<number>;
  approve(handle: PlanGateHandle): Promise<void>;
  reject(handle: PlanGateHandle): Promise<void>;
}

const emptySchema = z.object({}).strict();

const RESERVED_OPTION_LABELS = new Set(
  ["Approve", "Reject", "Reject and Exit", "Revise"].map((label) =>
    label.trim().toLowerCase()
  )
);

const optionSchema = z
  .object({
    label: z.string().min(1).max(80),
    description: z.string().default("")
  })
  .strict();

const exitSchema = z
  .object({
    options: z
      .array(optionSchema)
      .min(2)
      .max(3)
      .refine(
        (options) =>
          new Set(options.map((option) => option.label.trim().toLowerCase()))
            .size === options.length,
        "Option labels must be unique."
      )
      .refine(
        (options) =>
          options.every(
            (option) => !RESERVED_OPTION_LABELS.has(option.label.trim().toLowerCase())
          ),
        "Option labels must not use reserved approval labels."
      )
      .optional()
  })
  .strict();

export const createEnterPlanModeTool = (
  store: PlanGateStore,
  state: PlanGateState,
): AgentTool =>
  buildTool({
    name: "enter_plan_mode",
    description:
      "Enter plan mode: a read-mostly planning state where direct file writes are limited to the current plan file. Use before non-trivial implementation.",
    inputSchema: emptySchema,
    // 会写 DB/建文件,不是 readOnly;但进入的是更受限状态,不再弹一次审批。
    readOnly: false,
    execute: async () => {
      if (state.current().active) {
        return "Error: Plan mode is already active. Update the current plan file or call exit_plan_mode.";
      }

      try {
        const handle = await store.enter();
        state.enter(handle);
        return [
          "Plan mode is now active.",
          `Plan file: ${handle.planPath}`,
          "Write the plan to that file, then call exit_plan_mode for approval.",
        ].join("\n");
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Failed to enter plan mode."}`;
      }
    },
  });

export const createExitPlanModeTool = (
  store: PlanGateStore,
  state: PlanGateState,
  requestPlanReview?: RequestPlanReview,
): AgentTool =>
  buildTool({
    name: "exit_plan_mode",
    description:
      "Submit the current plan for approval and exit plan mode. The plan file must be non-empty.",
    inputSchema: exitSchema,
    // T45b:有平行通道时不走 boolean withApproval;没有通道(测试桩/旧路径)才退回 boolean。
    needsApproval: requestPlanReview === undefined,
    execute: async (input, execOptions) => {
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
        return "Error: exit_plan_mode can only be called while plan mode is active.";
      }

      const content = await store.readPlan(handle);
      if (content.trim().length === 0) {
        return `Error: No plan content found. Write your plan to ${handle.planPath} first, then call exit_plan_mode.`;
      }

      const revision = await store.recordRevision(handle);

      // T45a 兼容路径:无平行通道时,withApproval 已在 execute 前问过 boolean(true 才到这)。
      if (requestPlanReview === undefined) {
        await store.approve(handle);
        state.exit();
        return `Plan approved (revision v${revision}). Plan mode deactivated.`;
      }

      const decision = await requestPlanReview({
        toolCallId: execOptions?.toolCallId ?? `plan-review-${handle.planId}`,
        planId: handle.planId,
        planPath: handle.planPath,
        content,
        revision,
        ...(input.options !== undefined ? { options: input.options } : {}),
      });

      switch (decision.outcome) {
        case "approve": {
          await store.approve(handle);
          state.exit();
          const selected = decision.selectedLabel
            ? `Selected approach: ${decision.selectedLabel}\nExecute ONLY the selected approach. Do not execute any unselected alternatives.\n\n`
            : "";
          return `${selected}Plan approved (revision v${revision}). Plan mode deactivated.`;
        }
        case "revise": {
          const feedback = decision.feedback ?? "";
          return `User rejected the plan. Feedback:\n\n${feedback}\n\nRevise the plan and call exit_plan_mode again.`;
        }
        case "reject": {
          state.requestStopTurn();
          const feedback = decision.feedback ? `\n\n${decision.feedback}` : "";
          return `Error: Plan rejected. Plan mode remains active.${feedback}`;
        }
        case "reject_and_exit": {
          await store.reject(handle);
          state.exit();
          state.requestStopTurn();
          return "Error: Plan rejected by user. Plan mode deactivated.";
        }
        case "dismissed": {
          return "Plan approval dismissed. Plan mode remains active.";
        }
      }
    },
  });
