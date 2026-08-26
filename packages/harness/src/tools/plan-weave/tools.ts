import { z } from "zod";

import { buildTool, type AgentTool } from "../build-tool.js";
import { planInputSchema, type PlanWeaveGateway } from "./gateway.js";

const emptySchema = z.object({}).strict();

/**
 * T46:Plan Weave 六个内置工具。
 *
 * 契约(docs/plans/r12/00-overview §3 契约 8):
 * - 入参不带任何路径 —— workspaceId/runId 在 server 侧绑进 gateway,模型给不了路径,
 *   这才是这些工具不设 needsApproval 站得住的理由;
 * - 只有 plan_status 是 readOnly —— 其余会写文件,误标会被 T24 只读并发帽当只读放行,
 *   并发写就绕过了 per-workspace mutex 的串行意图;
 * - 全部 .strict():多塞的字段(尤其是路径字段)直接报错,不影响实际写入位置。
 */
export const createPlanWeaveTools = (gateway: PlanWeaveGateway): AgentTool[] => [
  buildTool({
    name: "plan_create",
    description:
      "Create a workspace-level task graph (plan.json + state.json under .eva/plan-weave/) from a plan: tasks with ordered blocks, deps between blocks ('T1:B1' refs), acceptance criteria, and maxReviewCycles per block. Fails if a plan already exists — archive or reset it first. After creating, call plan_claim to start working.",
    inputSchema: z.object({ plan: planInputSchema }).strict(),
    execute: async (input) => gateway.create(input.plan)
  }),

  buildTool({
    name: "plan_status",
    description:
      "Show the plan-weave task graph: progress, per-block status, the current claim (and its owner), and open feedback.",
    inputSchema: emptySchema,
    readOnly: true,
    execute: async () => gateway.status()
  }),

  buildTool({
    name: "plan_claim",
    description:
      "Claim the next work unit from the plan-weave task graph and get its work packet. Open feedback ALWAYS takes priority over new blocks. The packet is self-contained (goal, task context, instructions, acceptance, upstream report summaries) and can be handed to a subagent verbatim. Idempotent: claiming again with the same run returns the same packet with alreadyClaimed: true; while another run holds the claim it returns busy with the owner.",
    inputSchema: emptySchema,
    execute: async () => gateway.claim()
  }),

  buildTool({
    name: "plan_submit",
    description:
      "Submit the report for a claimed block (writes results/<task>/<block>.run-N.md). The block then awaits review via plan_review.",
    inputSchema: z
      .object({
        ref: z.string().min(1).describe("block ref, e.g. T1:B1"),
        report: z.string().min(1).describe("what was done and how it meets the acceptance criteria")
      })
      .strict(),
    execute: async (input) => gateway.submit(input.ref, input.report)
  }),

  buildTool({
    name: "plan_review",
    description:
      "Review a submitted block. verdict 'approved' marks it done; 'needs_changes' (notes required) sends the block back to ready for another run. When a block reaches its maxReviewCycles the gate closes and it passes automatically (recorded in the review file) — do not loop reviews forever.",
    inputSchema: z
      .object({
        ref: z.string().min(1).describe("block ref, e.g. T1:B1"),
        verdict: z.enum(["approved", "needs_changes"]),
        notes: z.string().optional().describe("required when verdict is needs_changes")
      })
      .strict(),
    execute: async (input) => gateway.review(input.ref, input.verdict, input.notes)
  }),

  buildTool({
    name: "plan_resolve",
    description:
      "Resolve an open feedback item (writes FB-N.resolution.md) so block claims can proceed.",
    inputSchema: z
      .object({
        feedbackId: z.string().min(1).describe("feedback id, e.g. FB-1"),
        resolution: z.string().min(1).describe("how the feedback was addressed")
      })
      .strict(),
    execute: async (input) => gateway.resolve(input.feedbackId, input.resolution)
  })
];
