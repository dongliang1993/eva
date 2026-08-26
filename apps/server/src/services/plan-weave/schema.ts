import { z } from "zod";

import {
  planInputSchema,
  type PlanBlockInput,
  type PlanInput,
  type PlanTaskInput
} from "@eva/harness";

/** T46:业务错误码 → REST 状态码的映射在 routes/plan-weave.ts。 */
export type PlanWeaveErrorCode =
  | "workspace_not_found"
  | "no_plan"
  | "not_found"
  | "plan_exists"
  | "invalid"
  | "bad_request";

export class PlanWeaveError extends Error {
  constructor(
    readonly code: PlanWeaveErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PlanWeaveError";
  }
}

// ---------- plan.json ----------

export const PLAN_WEAVE_VERSION = 1;

/** 落盘的 plan.json = 模型入参 + version/时间戳(由 service 生成,不来自模型)。 */
export const planFileSchema = planInputSchema.extend({
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type PlanBlock = PlanBlockInput;
export type PlanTask = Omit<PlanTaskInput, "blocks"> & { blocks: PlanBlock[] };
export type PlanFile = Omit<PlanInput, "tasks"> & {
  version: number;
  createdAt: string;
  updatedAt: string;
  tasks: PlanTask[];
};

// ---------- state.json ----------

export type BlockStatus = "pending" | "ready" | "in_progress" | "done" | "blocked";

export const blockStateSchema = z.object({
  // ready 不是持久真相:存这里只是上次写的快照,每次读写都按 deps 重算(ready.ts)。
  status: z.enum(["pending", "ready", "in_progress", "done", "blocked"]),
  runs: z.number().int().nonnegative().default(0),
  reviews: z.number().int().nonnegative().default(0),
  blockedReason: z.string().optional()
});

export const currentClaimSchema = z.object({
  kind: z.enum(["block", "feedback"]),
  id: z.string().min(1),
  claimedAt: z.string(),
  /** 占坑的 runId —— 「不丢 in_progress 负责人」这条红线落在数据上。 */
  owner: z.string().min(1)
});

export const feedbackItemSchema = z.object({
  id: z.string().min(1),
  blockId: z.string().min(1),
  content: z.string().default(""),
  status: z.enum(["open", "resolved"]),
  createdAt: z.string(),
  resolvedAt: z.string().optional()
});

export const stateFileSchema = z.object({
  blocks: z.record(z.string(), blockStateSchema).default({}),
  current: currentClaimSchema.nullable().default(null),
  feedback: z.array(feedbackItemSchema).default([]),
  updatedAt: z.string().default("")
});

export type BlockState = z.infer<typeof blockStateSchema>;
export type CurrentClaim = z.infer<typeof currentClaimSchema>;
export type FeedbackItem = z.infer<typeof feedbackItemSchema>;
export type StateFile = z.infer<typeof stateFileSchema>;

export const freshState = (now: string): StateFile => ({
  blocks: {},
  current: null,
  feedback: [],
  updatedAt: now
});

// ---------- create 校验 ----------

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const parseRef = (ref: string): { taskId: string; blockId: string } => {
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]*):([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(ref);
  if (!match) {
    throw new PlanWeaveError("bad_request", `ref 格式非法:"${ref}"(应为 "T1:B1" 形式)`);
  }
  return { taskId: match[1]!, blockId: match[2]! };
};

export const refOf = (taskId: string, blockId: string): string => `${taskId}:${blockId}`;

/**
 * create 的语义校验(zod 管形状,这里管引用):
 * task/block id 唯一、deps 只引用已存在的 ref、无环。
 * 校验失败只抛错不落盘 —— 调用方保证「先校验后写」。
 */
export const validatePlan = (plan: PlanInput): void => {
  const taskIds = new Set<string>();
  const refs = new Set<string>();
  const depEdges = new Map<string, string[]>();

  for (const task of plan.tasks) {
    if (taskIds.has(task.id)) {
      throw new PlanWeaveError("invalid", `task id 重复:"${task.id}"`);
    }
    taskIds.add(task.id);

    const blockIds = new Set<string>();
    for (const block of task.blocks) {
      if (blockIds.has(block.id)) {
        throw new PlanWeaveError("invalid", `block id 重复:"${refOf(task.id, block.id)}"`);
      }
      blockIds.add(block.id);
      refs.add(refOf(task.id, block.id));
      depEdges.set(refOf(task.id, block.id), block.deps);
    }
  }

  for (const [ref, deps] of depEdges) {
    for (const dep of deps) {
      if (!REF_PATTERN.test(dep)) {
        throw new PlanWeaveError("invalid", `${ref} 的 dep "${dep}" 不是合法的 "T1:B1" ref`);
      }
      if (!refs.has(dep)) {
        throw new PlanWeaveError("invalid", `${ref} 的 dep "${dep}" 不存在于 plan 中`);
      }
    }
  }

  // 无环:三色 DFS,报出环上的一条边方便定位。
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (ref: string, trail: string[]): void => {
    if (done.has(ref)) return;
    if (visiting.has(ref)) {
      throw new PlanWeaveError(
        "invalid",
        `deps 存在循环依赖:${[...trail, ref].join(" -> ")}`
      );
    }
    visiting.add(ref);
    for (const dep of depEdges.get(ref) ?? []) {
      visit(dep, [...trail, ref]);
    }
    visiting.delete(ref);
    done.add(ref);
  };
  for (const ref of refs) {
    visit(ref, []);
  }
};
