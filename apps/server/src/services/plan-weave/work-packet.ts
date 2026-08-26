import type { BlockStatus } from "./schema.js";
import type { FeedbackItem, PlanBlock, PlanFile, PlanTask } from "./schema.js";

/** 上游报告摘要的截断长度 —— packet 给的是「上文干了什么」的线索,不是全文。 */
const UPSTREAM_SUMMARY_MAX = 800;

const STATUS_MARK: Record<BlockStatus, string> = {
  done: "x",
  in_progress: "~",
  blocked: "!",
  ready: " ",
  pending: " "
};

export interface UpstreamReport {
  readonly ref: string;
  readonly title: string;
  readonly summary: string | undefined;
}

const truncate = (text: string): string =>
  text.length > UPSTREAM_SUMMARY_MAX
    ? `${text.slice(0, UPSTREAM_SUMMARY_MAX)}\n…(truncated)`
    : text;

/**
 * 生成人/模型都能读的 Markdown work packet(T46 §2.4)。
 * 收尾指令是「产出后调 plan_submit / plan_resolve」—— 不是 curl,
 * 模型没有也不该有 HTTP 路径。
 */
export const buildBlockPacket = (input: {
  readonly plan: PlanFile;
  readonly task: PlanTask;
  readonly block: PlanBlock;
  readonly ref: string;
  readonly statuses: Map<string, BlockStatus>;
  readonly upstream: readonly UpstreamReport[];
}): string => {
  const { plan, task, block, ref, statuses, upstream } = input;

  const taskOutline = task.blocks
    .map((b) => {
      const mark = STATUS_MARK[statuses.get(`${task.id}:${b.id}`) ?? "pending"];
      return `- [${mark}] ${task.id}:${b.id} ${b.title}`;
    })
    .join("\n");

  const upstreamSection =
    upstream.length === 0
      ? "(no upstream blocks)"
      : upstream
          .map(
            (u) =>
              `### ${u.ref} — ${u.title}\n\n${u.summary ? truncate(u.summary) : "(no report yet)"}`
          )
          .join("\n\n");

  return [
    `# Work Packet: ${ref} — ${block.title}`,
    "",
    `## Plan Goal`,
    plan.goal,
    "",
    `## Task ${task.id}: ${task.title}`,
    taskOutline,
    "",
    `## Your Block: ${ref}`,
    block.instructions,
    "",
    "## Acceptance",
    block.acceptance,
    "",
    "## Upstream Reports",
    upstreamSection,
    "",
    "## When Done",
    `- Call \`plan_submit\` with ref "${ref}" and a report of what you did.`,
    "- This packet is self-contained: it can be handed to a subagent verbatim."
  ].join("\n");
};

export const buildFeedbackPacket = (input: {
  readonly plan: PlanFile;
  readonly feedback: FeedbackItem;
}): string => {
  const { plan, feedback } = input;
  return [
    `# Feedback Packet: ${feedback.id} (re: ${feedback.blockId})`,
    "",
    `## Plan Goal`,
    plan.goal,
    "",
    "## Open Feedback",
    feedback.content || "(no detail — see state.json)",
    "",
    "Open feedback outranks all other work. Address it,",
    `then call \`plan_resolve\` with feedbackId "${feedback.id}" and a resolution report.`
  ].join("\n");
};
