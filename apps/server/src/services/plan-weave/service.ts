import { planInputSchema, type PlanInput } from "@eva/harness";

import type { WorkspaceStore } from "../workspaces/workspace-store.js";
import { PlanFileStore } from "./plan-file-store.js";
import {
  computeEffectiveStatuses,
  firstReadyRef,
  flattenBlocks,
  freshBlockState,
  progressOf
} from "./ready.js";
import {
  parseRef,
  refOf,
  validatePlan,
  PlanWeaveError,
  PLAN_WEAVE_VERSION,
  type BlockStatus,
  type CurrentClaim,
  type FeedbackItem,
  type PlanBlock,
  type PlanFile,
  type PlanTask,
  type StateFile
} from "./schema.js";
import {
  buildBlockPacket,
  buildFeedbackPacket,
  type UpstreamReport
} from "./work-packet.js";

export interface BlockSnapshot {
  readonly ref: string;
  readonly taskId: string;
  readonly blockId: string;
  readonly title: string;
  readonly status: BlockStatus;
  readonly runs: number;
  readonly reviews: number;
  readonly deps: readonly string[];
  readonly acceptance: string;
  readonly maxReviewCycles: number;
  readonly blockedReason?: string;
}

export interface PlanSnapshot {
  readonly title: string;
  readonly goal: string;
  readonly progress: { readonly done: number; readonly total: number };
  readonly tasks: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly blocks: readonly BlockSnapshot[];
  }>;
  readonly current: CurrentClaim | null;
  readonly openFeedback: readonly FeedbackItem[];
  readonly feedback: readonly FeedbackItem[];
}

export interface BlockDetail extends BlockSnapshot {
  readonly instructions: string;
  readonly artifacts: readonly string[];
}

export type ClaimResult =
  | { readonly kind: "block"; readonly ref: string; readonly packet: string; readonly alreadyClaimed: boolean }
  | { readonly kind: "feedback"; readonly feedbackId: string; readonly packet: string; readonly alreadyClaimed: boolean }
  | { readonly kind: "busy"; readonly owner: string; readonly current: CurrentClaim }
  | { readonly kind: "none"; readonly reason: string };

export interface SubmitResult {
  readonly ref: string;
  readonly runs: number;
}

export interface ReviewResult {
  readonly ref: string;
  readonly verdict: "approved" | "needs_changes";
  readonly status: BlockStatus;
  readonly reviews: number;
  /** true = reviews 达 maxReviewCycles,自动关门放行(留痕在 review 文件里)。 */
  readonly forced: boolean;
}

export interface ResolveResult {
  readonly feedbackId: string;
  readonly status: "resolved";
}

/**
 * T46 §2.4:Plan Weave 业务层。所有 mutation 走
 * 「rootFor → withLock → 读 → 改 → 原子写 → 出锁」;
 * work packet 这类要读上游报告的慢活在锁外组(坑 3:锁内不做慢活)。
 */
export class PlanWeaveService {
  constructor(
    private readonly workspaces: WorkspaceStore,
    private readonly store: PlanFileStore = new PlanFileStore()
  ) {}

  private rootFor(workspaceId: string): string {
    const workspace = this.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new PlanWeaveError("workspace_not_found", `Workspace not found: ${workspaceId}`);
    }
    return workspace.path;
  }

  private async mustReadPlan(root: string): Promise<PlanFile> {
    const plan = await this.store.readPlan(root);
    if (!plan) {
      throw new PlanWeaveError(
        "no_plan",
        "该 workspace 还没有 plan。先 plan_create / POST plan 创建一个。"
      );
    }
    return plan;
  }

  private findBlock(
    plan: PlanFile,
    ref: string
  ): { task: PlanTask; block: PlanBlock } {
    const { taskId, blockId } = parseRef(ref);
    const found = flattenBlocks(plan).find((f) => f.ref === refOf(taskId, blockId));
    if (!found) {
      throw new PlanWeaveError("not_found", `Block not found: ${ref}`);
    }
    return { task: found.task, block: found.block };
  }

  private toSnapshot(plan: PlanFile, state: StateFile): PlanSnapshot {
    const statuses = computeEffectiveStatuses(plan, state);
    return {
      title: plan.title,
      goal: plan.goal,
      progress: progressOf(statuses),
      tasks: plan.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        blocks: task.blocks.map((block) => {
          const ref = refOf(task.id, block.id);
          const bs = state.blocks[ref];
          return {
            ref,
            taskId: task.id,
            blockId: block.id,
            title: block.title,
            status: statuses.get(ref) ?? "pending",
            runs: bs?.runs ?? 0,
            reviews: bs?.reviews ?? 0,
            deps: block.deps,
            acceptance: block.acceptance,
            maxReviewCycles: block.maxReviewCycles,
            ...(bs?.blockedReason !== undefined
              ? { blockedReason: bs.blockedReason }
              : {})
          };
        })
      })),
      current: state.current,
      openFeedback: state.feedback.filter((f) => f.status === "open"),
      feedback: state.feedback
    };
  }

  /** 读锁外:原子写保证单文件一致,状态概览容忍两份文件间的轻微时间差。 */
  async get(workspaceId: string): Promise<PlanSnapshot> {
    const root = this.rootFor(workspaceId);
    const plan = await this.mustReadPlan(root);
    const state = await this.store.readState(root);
    return this.toSnapshot(plan, state);
  }

  async getBlock(workspaceId: string, ref: string): Promise<BlockDetail> {
    const root = this.rootFor(workspaceId);
    const plan = await this.mustReadPlan(root);
    const state = await this.store.readState(root);
    const { task, block } = this.findBlock(plan, ref);
    const statuses = computeEffectiveStatuses(plan, state);
    const bs = state.blocks[ref];
    const artifacts = (await this.store.listResults(root, task.id)).filter((name) =>
      name.startsWith(`${block.id}.`)
    );

    return {
      ref,
      taskId: task.id,
      blockId: block.id,
      title: block.title,
      status: statuses.get(ref) ?? "pending",
      runs: bs?.runs ?? 0,
      reviews: bs?.reviews ?? 0,
      deps: block.deps,
      acceptance: block.acceptance,
      maxReviewCycles: block.maxReviewCycles,
      ...(bs?.blockedReason !== undefined ? { blockedReason: bs.blockedReason } : {}),
      instructions: block.instructions,
      artifacts
    };
  }

  async create(workspaceId: string, rawPlan: unknown): Promise<PlanSnapshot> {
    const root = this.rootFor(workspaceId);

    return this.store.withLock(workspaceId, async () => {
      if (this.store.exists(root)) {
        throw new PlanWeaveError(
          "plan_exists",
          "该 workspace 已存在 plan;请先 archive 或 reset,不会静默覆盖。"
        );
      }

      const parsed = planInputSchema.safeParse(rawPlan);
      if (!parsed.success) {
        throw new PlanWeaveError(
          "invalid",
          `plan 形状不合法:${parsed.error.issues[0]?.message ?? "schema 校验失败"}`
        );
      }
      validatePlan(parsed.data);

      const now = new Date().toISOString();
      const input: PlanInput = parsed.data;
      const plan: PlanFile = {
        ...input,
        version: PLAN_WEAVE_VERSION,
        createdAt: now,
        updatedAt: now
      };
      const state: StateFile = { blocks: {}, current: null, feedback: [], updatedAt: now };

      await this.store.writePlan(root, plan);
      await this.store.writeState(root, state);
      return this.toSnapshot(plan, state);
    });
  }

  async claim(workspaceId: string, runId: string): Promise<ClaimResult> {
    const root = this.rootFor(workspaceId);

    // 锁内只做「判定 + 状态翻转」,packet 素材(plan/state/claim)带出来在锁外组装。
    type Decision =
      | { readonly kind: "resend"; readonly plan: PlanFile; readonly state: StateFile; readonly current: CurrentClaim }
      | { readonly kind: "busy"; readonly owner: string; readonly current: CurrentClaim }
      | { readonly kind: "none"; readonly reason: string }
      | { readonly kind: "feedback"; readonly plan: PlanFile; readonly state: StateFile; readonly feedback: FeedbackItem; readonly alreadyClaimed: boolean }
      | { readonly kind: "block"; readonly plan: PlanFile; readonly state: StateFile; readonly ref: string; readonly alreadyClaimed: boolean };

    const decision = await this.store.withLock<Decision>(workspaceId, async () => {
      const plan = await this.mustReadPlan(root);
      const state = await this.store.readState(root);
      const now = new Date().toISOString();

      // 顺序依据:幂等重发 > busy > open feedback > 新 block。
      // 「feedback 永远优先于新 block」(§2.2)—— 是优先于*新* block;
      // 已占坑的重发/占坑检查在前,否则同 run 重复 claim 会冒出第二个 in_progress(坑 1)。
      const current = state.current;
      if (current) {
        if (current.owner === runId) {
          return { kind: "resend", plan, state, current };
        }
        return { kind: "busy", owner: current.owner, current };
      }

      const open = state.feedback.find((f) => f.status === "open");
      if (open) {
        state.current = { kind: "feedback", id: open.id, claimedAt: now, owner: runId };
        state.updatedAt = now;
        await this.store.writeState(root, state);
        return { kind: "feedback", plan, state, feedback: open, alreadyClaimed: false };
      }

      const statuses = computeEffectiveStatuses(plan, state);
      const ref = firstReadyRef(plan, statuses);
      if (!ref) {
        return { kind: "none", reason: noneReason(plan, statuses, state) };
      }

      const bs = state.blocks[ref] ?? freshBlockState("ready");
      bs.status = "in_progress";
      state.blocks[ref] = bs;
      state.current = { kind: "block", id: ref, claimedAt: now, owner: runId };
      state.updatedAt = now;
      await this.store.writeState(root, state);
      return { kind: "block", plan, state, ref, alreadyClaimed: false };
    });

    // ---- 锁外:组 packet(可能要读上游报告文件)----
    switch (decision.kind) {
      case "busy":
        return { kind: "busy", owner: decision.owner, current: decision.current };
      case "none":
        return decision;
      case "resend": {
        const { plan, state, current } = decision;
        if (current.kind === "feedback") {
          const feedback = state.feedback.find((f) => f.id === current.id);
          if (!feedback) {
            // 人手把 feedback 删了而 current 还指着它 —— 清掉重来,别永久 busy(坑 4)。
            return this.releaseStaleCurrent(workspaceId, root, runId);
          }
          return {
            kind: "feedback",
            feedbackId: feedback.id,
            packet: buildFeedbackPacket({ plan, feedback }),
            alreadyClaimed: true
          };
        }
        const { task, block } = this.findBlock(plan, current.id);
        const packet = await this.blockPacket(root, plan, state, task, block, current.id);
        return { kind: "block", ref: current.id, packet, alreadyClaimed: true };
      }
      case "feedback": {
        const { plan, feedback } = decision;
        // 物化 FB-N.md(人直接在 state.json 里塞的 feedback 可能没有这个文件)。
        const { taskId } = parseRef(feedback.blockId);
        const fileName = `${feedback.id}.md`;
        if ((await this.store.readResult(root, taskId, fileName)) === undefined) {
          await this.store.writeResult(
            root,
            taskId,
            fileName,
            `# ${feedback.id} (re: ${feedback.blockId})\n\n${feedback.content}\n`
          );
        }
        return {
          kind: "feedback",
          feedbackId: feedback.id,
          packet: buildFeedbackPacket({ plan, feedback }),
          alreadyClaimed: false
        };
      }
      case "block": {
        const { plan, state, ref } = decision;
        const { task, block } = this.findBlock(plan, ref);
        const packet = await this.blockPacket(root, plan, state, task, block, ref);
        return { kind: "block", ref, packet, alreadyClaimed: false };
      }
    }
  }

  /**
   * current 指向已被删的 feedback 时的自愈路径:清掉 current 重走 claim。
   * 正常流程到不了这里( resolve 才清 current),只有人手改 state.json 能造出来。
   */
  private async releaseStaleCurrent(
    workspaceId: string,
    root: string,
    runId: string
  ): Promise<ClaimResult> {
    await this.store.withLock(workspaceId, async () => {
      const latest = await this.store.readState(root);
      latest.current = null;
      latest.updatedAt = new Date().toISOString();
      await this.store.writeState(root, latest);
    });
    return this.claim(workspaceId, runId);
  }

  /** 组 block packet:读齐上游 block 最新一份 run 报告的摘要(锁外慢活)。 */
  private async blockPacket(
    root: string,
    plan: PlanFile,
    state: StateFile,
    task: PlanTask,
    block: PlanBlock,
    ref: string
  ): Promise<string> {
    const statuses = computeEffectiveStatuses(plan, state);
    const upstream: UpstreamReport[] = [];
    for (const dep of block.deps) {
      try {
        const { task: depTask, block: depBlock } = this.findBlock(plan, dep);
        const runs = state.blocks[dep]?.runs ?? 0;
        const summary =
          runs > 0
            ? await this.store.readResult(root, depTask.id, `${depBlock.id}.run-${runs}.md`)
            : undefined;
        upstream.push({ ref: dep, title: depBlock.title, summary });
      } catch {
        upstream.push({ ref: dep, title: "(removed)", summary: undefined });
      }
    }
    return buildBlockPacket({ plan, task, block, ref, statuses, upstream });
  }

  async submit(workspaceId: string, ref: string, report: string): Promise<SubmitResult> {
    const root = this.rootFor(workspaceId);

    return this.store.withLock(workspaceId, async () => {
      const plan = await this.mustReadPlan(root);
      const { task, block } = this.findBlock(plan, ref);
      const state = await this.store.readState(root);
      const statuses = computeEffectiveStatuses(plan, state);

      if (statuses.get(ref) !== "in_progress") {
        throw new PlanWeaveError(
          "bad_request",
          `Block ${ref} 不能 submit:当前状态是 ${statuses.get(ref) ?? "unknown"}(需先 claim 成 in_progress)。`
        );
      }

      const bs = state.blocks[ref] ?? freshBlockState("in_progress");
      bs.runs += 1;
      state.blocks[ref] = bs;
      // submit 后 block 等待 review,坑位让出 —— 下一个 ready block 可以被 claim。
      if (state.current?.kind === "block" && state.current.id === ref) {
        state.current = null;
      }
      state.updatedAt = new Date().toISOString();

      await this.store.writeResult(root, task.id, `${block.id}.run-${bs.runs}.md`, report);
      await this.store.writeState(root, state);
      return { ref, runs: bs.runs };
    });
  }

  async review(
    workspaceId: string,
    ref: string,
    verdict: "approved" | "needs_changes",
    notes?: string
  ): Promise<ReviewResult> {
    const root = this.rootFor(workspaceId);

    return this.store.withLock(workspaceId, async () => {
      if (verdict === "needs_changes" && !notes?.trim()) {
        throw new PlanWeaveError("bad_request", "needs_changes 必须带 notes。");
      }

      const plan = await this.mustReadPlan(root);
      const { task, block } = this.findBlock(plan, ref);
      const state = await this.store.readState(root);
      const statuses = computeEffectiveStatuses(plan, state);
      const bs = state.blocks[ref] ?? freshBlockState("in_progress");

      if (statuses.get(ref) !== "in_progress" || bs.runs === 0) {
        throw new PlanWeaveError(
          "bad_request",
          `Block ${ref} 不能 review:状态 ${statuses.get(ref) ?? "unknown"},runs=${bs.runs}(需先 submit)。`
        );
      }

      const now = new Date().toISOString();
      const clearCurrent = () => {
        // 坑 4:owner 要清干净,否则任务图永久 busy。
        if (state.current?.kind === "block" && state.current.id === ref) {
          state.current = null;
        }
      };

      if (verdict === "approved") {
        bs.status = "done";
        state.blocks[ref] = bs;
        clearCurrent();
        state.updatedAt = now;
        await this.store.writeState(root, state);
        return { ref, verdict, status: "done" as const, reviews: bs.reviews, forced: false };
      }

      // needs_changes:回 ready 再来一轮;到达 maxReviewCycles 自动关门放行(防 ping-pong)。
      bs.reviews += 1;
      const forced = bs.reviews >= block.maxReviewCycles;
      bs.status = forced ? "done" : "ready";
      state.blocks[ref] = bs;
      clearCurrent();
      state.updatedAt = now;

      const reviewMd = [
        `# Review ${bs.reviews}: ${ref} — needs_changes`,
        "",
        notes!.trim(),
        "",
        ...(forced
          ? [`> 已达上限,强制通过(maxReviewCycles=${block.maxReviewCycles})。`]
          : [])
      ].join("\n");

      await this.store.writeResult(root, task.id, `${block.id}.review-${bs.reviews}.md`, reviewMd);
      await this.store.writeState(root, state);
      return {
        ref,
        verdict,
        status: bs.status as BlockStatus,
        reviews: bs.reviews,
        forced
      };
    });
  }

  async resolve(
    workspaceId: string,
    feedbackId: string,
    resolution: string
  ): Promise<ResolveResult> {
    const root = this.rootFor(workspaceId);

    return this.store.withLock(workspaceId, async () => {
      await this.mustReadPlan(root);
      const state = await this.store.readState(root);
      const feedback = state.feedback.find((f) => f.id === feedbackId);
      if (!feedback) {
        throw new PlanWeaveError("not_found", `Feedback not found: ${feedbackId}`);
      }
      if (feedback.status !== "open") {
        throw new PlanWeaveError("bad_request", `Feedback ${feedbackId} 已经关闭。`);
      }

      const now = new Date().toISOString();
      feedback.status = "resolved";
      feedback.resolvedAt = now;
      if (state.current?.kind === "feedback" && state.current.id === feedbackId) {
        state.current = null;
      }
      state.updatedAt = now;

      const { taskId } = parseRef(feedback.blockId);
      await this.store.writeResult(
        root,
        taskId,
        `${feedback.id}.resolution.md`,
        `# Resolution: ${feedback.id}\n\n${resolution}\n`
      );
      await this.store.writeState(root, state);
      return { feedbackId, status: "resolved" as const };
    });
  }

  /** 阻塞/解阻塞一个 block。done 不可 block;block 必须给 reason(对齐 Alma)。 */
  async setBlocked(
    workspaceId: string,
    ref: string,
    blocked: boolean,
    reason?: string
  ): Promise<BlockSnapshot> {
    const root = this.rootFor(workspaceId);

    return this.store.withLock(workspaceId, async () => {
      const plan = await this.mustReadPlan(root);
      this.findBlock(plan, ref);
      const state = await this.store.readState(root);
      const statuses = computeEffectiveStatuses(plan, state);
      const current = statuses.get(ref) ?? "pending";

      if (blocked) {
        if (current === "done") {
          throw new PlanWeaveError("bad_request", `Block ${ref} 已 done,不可 block。`);
        }
        if (!reason?.trim()) {
          throw new PlanWeaveError("bad_request", "block 必须给 reason。");
        }
      }

      const bs = state.blocks[ref] ?? freshBlockState(current);
      if (blocked) {
        bs.status = "blocked";
        bs.blockedReason = reason!.trim();
        if (state.current?.kind === "block" && state.current.id === ref) {
          state.current = null;
        }
      } else {
        // 回到 pending/ready 由重算决定,存 pending 即可。
        bs.status = "pending";
        delete bs.blockedReason;
      }
      state.blocks[ref] = bs;
      state.updatedAt = new Date().toISOString();
      await this.store.writeState(root, state);

      return this.toSnapshot(plan, state).tasks
        .flatMap((t) => t.blocks)
        .find((b) => b.ref === ref)!;
    });
  }

  /** 保留 plan.json,重置 state.json(Alma 同款)。 */
  async reset(workspaceId: string): Promise<PlanSnapshot> {
    const root = this.rootFor(workspaceId);

    return this.store.withLock(workspaceId, async () => {
      const plan = await this.mustReadPlan(root);
      const state: StateFile = {
        blocks: {},
        current: null,
        feedback: [],
        updatedAt: new Date().toISOString()
      };
      await this.store.writeState(root, state);
      return this.toSnapshot(plan, state);
    });
  }

  async archive(workspaceId: string): Promise<{ archivePath: string }> {
    const root = this.rootFor(workspaceId);

    return this.store.withLock(workspaceId, async () => {
      const plan = await this.mustReadPlan(root);
      const slug =
        plan.title
          .toLowerCase()
          .replace(/[^a-z0-9一-鿿]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "plan";
      const archivePath = await this.store.archive(root, slug);
      return { archivePath };
    });
  }

  /** DELETE:整个 plan-weave 目录删掉(Alma 的 rm -rf)。 */
  async remove(workspaceId: string): Promise<void> {
    const root = this.rootFor(workspaceId);

    await this.store.withLock(workspaceId, async () => {
      if (!this.store.exists(root)) {
        throw new PlanWeaveError("no_plan", "该 workspace 还没有 plan。");
      }
      await this.store.removeAll(root);
    });
  }
}

const noneReason = (
  plan: PlanFile,
  statuses: Map<string, BlockStatus>,
  state: StateFile
): string => {
  const { done, total } = progressOf(statuses);
  if (done === total) {
    return "所有 block 均已完成。";
  }
  const byStatus = (wanted: BlockStatus): string[] =>
    flattenBlocks(plan)
      .filter((f) => statuses.get(f.ref) === wanted)
      .map((f) => f.ref);
  const inReview = byStatus("in_progress");
  if (inReview.length > 0) {
    return `暂无可 claim 的 block:${inReview.join("、")} 已提交,等待 plan_review。`;
  }
  const blocked = byStatus("blocked");
  if (blocked.length > 0) {
    const reasons = blocked
      .map((ref) => `${ref}(${state.blocks[ref]?.blockedReason ?? "no reason"})`)
      .join("、");
    return `暂无可 claim 的 block:${reasons} 处于 blocked。`;
  }
  return "暂无可 claim 的 block:依赖未就绪。";
};
