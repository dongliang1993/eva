import { z } from "zod";

/**
 * T46:Plan Weave 工具的 server 侧能力接口。
 * harness 不认识 workspace/文件系统 —— server 把接口实现成直接调
 * PlanWeaveService(不过 HTTP、不带 loopback token,docs/plans/r12/T46 §2.6)。
 *
 * 方法全部返回 string:工具层不做格式化,业务文案由 server 一处产出。
 */
export interface PlanWeaveGateway {
  /** 写出 plan.json + 初始 state.json。已有 plan / 校验失败时抛错。 */
  create(plan: PlanInput): Promise<string>;
  /** 进度概览 + current + open feedback。 */
  status(): Promise<string>;
  /** 取下一个工作单元(open feedback 优先),返回 work packet。 */
  claim(): Promise<string>;
  submit(ref: string, report: string): Promise<string>;
  review(ref: string, verdict: "approved" | "needs_changes", notes?: string): Promise<string>;
  resolve(feedbackId: string, resolution: string): Promise<string>;
}

/**
 * task/block id 的合法字符集。id 会进 ref("T1:B1")并拼进
 * results/<taskId>/<blockId>.run-N.md 文件名 —— 这个 regex 同时是
 * 「id 不能变成路径逃逸」的边界(对齐 Alma 的 /^[A-Za-z0-9][A-Za-z0-9_-]*$/)。
 */
const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "id must match ^[A-Za-z0-9][A-Za-z0-9_-]*$");

export const planBlockInputSchema = z
  .object({
    id: idSchema.describe("block id, e.g. B1"),
    title: z.string().min(1),
    instructions: z.string().min(1).describe("what to do, in detail"),
    acceptance: z.string().min(1).describe("acceptance criteria checked at review"),
    deps: z
      .array(z.string().min(1))
      .default([])
      .describe("upstream block refs in 'T1:B1' format; all must be done before this block is ready"),
    maxReviewCycles: z
      .number()
      .int()
      .min(1)
      .default(3)
      .describe("max needs_changes rounds before the review gate auto-passes (>=1)")
  })
  .strict();

export const planTaskInputSchema = z
  .object({
    id: idSchema.describe("task id, e.g. T1"),
    title: z.string().min(1),
    blocks: z.array(planBlockInputSchema).min(1)
  })
  .strict();

export const planInputSchema = z
  .object({
    title: z.string().min(1),
    goal: z.string().min(1).describe("the overall goal this task graph achieves"),
    tasks: z.array(planTaskInputSchema).min(1)
  })
  .strict();

/** schema 默认值应用后的完整 plan 入参(工具 execute / service create 都吃这个)。 */
export type PlanInput = z.infer<typeof planInputSchema>;
export type PlanBlockInput = z.infer<typeof planBlockInputSchema>;
export type PlanTaskInput = z.infer<typeof planTaskInputSchema>;
