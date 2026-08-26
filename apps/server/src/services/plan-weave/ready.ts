import {
  refOf,
  type BlockState,
  type BlockStatus,
  type PlanBlock,
  type PlanFile,
  type PlanTask,
  type StateFile
} from "./schema.js";

export interface FlatBlock {
  readonly ref: string;
  readonly task: PlanTask;
  readonly block: PlanBlock;
}

/** 按声明顺序摊平 tasks[].blocks[](第一个 ready 的选取顺序 = 声明顺序)。 */
export const flattenBlocks = (plan: PlanFile): FlatBlock[] =>
  plan.tasks.flatMap((task) =>
    task.blocks.map((block) => ({ ref: refOf(task.id, block.id), task, block }))
  );

export const freshBlockState = (status: BlockStatus): BlockState => ({
  status,
  runs: 0,
  reviews: 0
});

/**
 * ready 重算(T46 §2.2):**每次读写都按 deps 重算,ready 不当持久字段**。
 * stored 为 done / in_progress / blocked 的保持原样(这些是真状态);
 * pending / ready 只是上次写的快照,按「deps 是否全 done」重新推导 ——
 * 人手改了 plan.json(加 dep / 删 block)也能自愈。
 *
 * 不动点迭代而不是按声明序一趟:dep 可以引用声明在后面的 block。
 * 手改引入环时,环上的 block 永远解析不出 → 兜底 pending(宁可卡住不可假装就绪)。
 */
export const computeEffectiveStatuses = (
  plan: PlanFile,
  state: StateFile
): Map<string, BlockStatus> => {
  const flat = flattenBlocks(plan);
  const statuses = new Map<string, BlockStatus>();
  const unresolved: FlatBlock[] = [];

  for (const entry of flat) {
    const stored = state.blocks[entry.ref];
    if (
      stored &&
      (stored.status === "done" ||
        stored.status === "in_progress" ||
        stored.status === "blocked")
    ) {
      statuses.set(entry.ref, stored.status);
    } else {
      unresolved.push(entry);
    }
  }

  let remaining = unresolved;
  while (remaining.length > 0) {
    const next: FlatBlock[] = [];
    let progressed = false;
    for (const entry of remaining) {
      const depStatuses = entry.block.deps.map((dep) => statuses.get(dep));
      if (depStatuses.some((status) => status === undefined)) {
        next.push(entry); // 有 dep 还没解析出来,下一轮再看
        continue;
      }
      // dep 指向已被删掉的 block(statuses 里永远不会有它)→ 按「未完成」处理。
      const depsDone = depStatuses.every((status) => status === "done");
      statuses.set(entry.ref, depsDone ? "ready" : "pending");
      progressed = true;
    }
    if (!progressed) {
      // 环或互指的悬挂 dep:全部按 pending 兜底。
      for (const entry of next) {
        statuses.set(entry.ref, "pending");
      }
      break;
    }
    remaining = next;
  }

  return statuses;
};

export const firstReadyRef = (
  plan: PlanFile,
  statuses: Map<string, BlockStatus>
): string | undefined =>
  flattenBlocks(plan).find(({ ref }) => statuses.get(ref) === "ready")?.ref;

export const progressOf = (
  statuses: Map<string, BlockStatus>
): { done: number; total: number } => {
  let done = 0;
  for (const status of statuses.values()) {
    if (status === "done") done += 1;
  }
  return { done, total: statuses.size };
};
