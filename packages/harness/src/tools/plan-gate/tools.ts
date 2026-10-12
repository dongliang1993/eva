import { z } from "zod";

import {
  errorResult,
  textResult,
  tool,
  type PipelineTool,
} from "../tool.js";
import type { PlanGateHandle, PlanGateState } from "./state.js";

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

const exitDecisionSchema = z
  .object({
    outcome: z.literal("approve"),
    selectedLabel: z.string().optional(),
    decidedAt: z.string().optional(),
  })
  .passthrough();

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
      .optional(),
    // server canUseTool 经 updatedInput 注入的审批决策;无 server 时缺席 → 直接批准。
    decision: exitDecisionSchema.optional(),
  })
  .strict();

export const createEnterPlanModeTool = (
  store: PlanGateStore,
  state: PlanGateState,
): PipelineTool =>
  tool({
    name: "enter_plan_mode",
    description:
      "Enter plan mode: a read-mostly planning state where direct file writes are limited to the current plan file. Use before non-trivial implementation.",
    inputSchema: emptySchema,
    // 会写 DB/建文件,不是 readOnly;但进入的是更受限状态,不再弹一次审批。
    annotations: { readOnlyHint: false },
    async execute() {
      if (state.current().active) {
        return errorResult(
          "Plan mode is already active. Update the current plan file or call exit_plan_mode.",
        );
      }

      try {
        const handle = await store.enter();
        state.enter(handle);
        return textResult([
          "Plan mode is now active.",
          `Plan file: ${handle.planPath}`,
          "Write the plan to that file, then call exit_plan_mode for approval.",
        ].join("\n"));
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to enter plan mode.",
        );
      }
    },
  });

/**
 * exit_plan_mode 的 execute 只剩 approve 分支(plan §3.4):
 * server 的 canUseTool 做完 plan review,经 updatedInput 注入 decision;
 * revise / reject / reject_and_exit / dismissed 都在 canUseTool 里 deny 掉,
 * execute 永远到不了。没有 decision(无 server 的测试场景)就当作直接批准。
 *
 * 前置校验(plan 未激活、plan 文件为空)留在这里兜底,但 server 必须在
 * 发审批帧之前做同样检查并直接 deny —— 不能为一个空 plan 弹审批卡。
 */
export const createExitPlanModeTool = (
  store: PlanGateStore,
  state: PlanGateState,
): PipelineTool =>
  tool({
    name: "exit_plan_mode",
    description:
      "Submit the current plan for approval and exit plan mode. The plan file must be non-empty.",
    inputSchema: exitSchema,
    async execute(input) {
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
        return errorResult("exit_plan_mode can only be called while plan mode is active.");
      }

      const content = await store.readPlan(handle);
      if (content.trim().length === 0) {
        return errorResult(
          `No plan content found. Write your plan to ${handle.planPath} first, then call exit_plan_mode.`,
        );
      }

      const revision = await store.recordRevision(handle);

      // server 注入的决策(canUseTool 的 updatedInput);无 server 时视为直接批准。
      // 非 approve 的分支到不了这里:canUseTool 只在 approve 时 allow。
      await store.approve(handle);
      state.exit();
      const selected = input.decision?.selectedLabel
        ? `Selected approach: ${input.decision.selectedLabel}\nExecute ONLY the selected approach. Do not execute any unselected alternatives.\n\n`
        : "";
      return textResult(`${selected}Plan approved (revision v${revision}). Plan mode deactivated.`);
    },
  });
