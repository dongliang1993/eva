import type { PlanWeaveGateway } from "@eva/harness";

import type { ClaimResult, PlanSnapshot, PlanWeaveService } from "./service.js";

const formatStatus = (snap: PlanSnapshot): string => {
  const lines: string[] = [
    `Plan: ${snap.title}`,
    `Goal: ${snap.goal}`,
    `Progress: ${snap.progress.done}/${snap.progress.total} done`,
    `Current: ${
      snap.current
        ? `${snap.current.kind} ${snap.current.id} (owner: ${snap.current.owner}, claimed at ${snap.current.claimedAt})`
        : "none"
    }`,
    `Open feedback: ${
      snap.openFeedback.length > 0
        ? snap.openFeedback.map((f) => `${f.id} (re: ${f.blockId}): ${f.content}`).join("; ")
        : "none"
    }`,
    ""
  ];

  for (const task of snap.tasks) {
    lines.push(`${task.id} ${task.title}`);
    for (const block of task.blocks) {
      const extra =
        block.status === "blocked" && block.blockedReason
          ? ` — ${block.blockedReason}`
          : "";
      lines.push(
        `  [${block.status}] ${block.ref} ${block.title} (runs ${block.runs}, reviews ${block.reviews}/${block.maxReviewCycles})${extra}`
      );
    }
  }
  return lines.join("\n");
};

const formatClaim = (result: ClaimResult): string => {
  switch (result.kind) {
    case "block":
      return `${result.alreadyClaimed ? "(already claimed — resending the same packet)\n\n" : ""}${result.packet}`;
    case "feedback":
      return `${result.alreadyClaimed ? "(already claimed — resending the same packet)\n\n" : ""}${result.packet}`;
    case "busy":
      return `The task graph is busy: ${result.current.kind} ${result.current.id} is claimed by run ${result.current.owner}. Try again after it is submitted/reviewed, or ask the user to reset.`;
    case "none":
      return `Nothing to claim. ${result.reason}`;
  }
};

/**
 * T46 §2.6:server 侧 gateway —— 直接调 service,不过 HTTP、不带 token。
 * 一个 run 一个实例,workspaceId/runId 在闭包里钉死,工具入参永远不带路径。
 */
export const createPlanWeaveGateway = (
  service: PlanWeaveService,
  workspaceId: string,
  runId: string
): PlanWeaveGateway => ({
  create: async (plan) => {
    const snap = await service.create(workspaceId, plan);
    return `Plan created: "${snap.title}" — ${snap.progress.total} blocks across ${snap.tasks.length} tasks. Call plan_claim to start working.`;
  },

  status: async () => formatStatus(await service.get(workspaceId)),

  claim: async () => formatClaim(await service.claim(workspaceId, runId)),

  submit: async (ref, report) => {
    const result = await service.submit(workspaceId, ref, report);
    return `Submitted ${result.ref} (run ${result.runs}). The block now awaits review — call plan_review with verdict "approved" or "needs_changes".`;
  },

  review: async (ref, verdict, notes) => {
    const result = await service.review(workspaceId, ref, verdict, notes);
    if (result.forced) {
      return `Review recorded for ${result.ref}: needs_changes (cycle ${result.reviews}), but maxReviewCycles reached — the gate closed and the block is now done (noted in the review file). Call plan_claim for the next unit.`;
    }
    if (result.status === "done") {
      return `Review recorded for ${result.ref}: approved — block done. Call plan_claim for the next unit.`;
    }
    return `Review recorded for ${result.ref}: needs_changes (cycle ${result.reviews}) — block back to ready. Call plan_claim to pick it up again.`;
  },

  resolve: async (feedbackId, resolution) => {
    await service.resolve(workspaceId, feedbackId, resolution);
    return `Feedback ${feedbackId} resolved. Call plan_claim for the next unit.`;
  }
});
