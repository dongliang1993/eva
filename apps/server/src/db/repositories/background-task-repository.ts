import { eq } from "drizzle-orm";

import type { TaskRecord } from "@eva/harness";

import type { AppDatabase } from "../index.js";
import { backgroundTasks } from "../schema.js";

export interface CreateBackgroundTaskInput {
  readonly id: string;
  readonly sessionId: string;
  readonly parentToolCallId: string;
  readonly subagentType: string;
  readonly depth: number;
}

/** background_tasks 表的行级读写(事实只在这里,Driz 不共享给 harness 层)。 */
const toTaskRecord = (row: typeof backgroundTasks.$inferSelect): TaskRecord => ({
  id: row.id,
  sessionId: row.sessionId,
  parentToolCallId: row.parentToolCallId,
  subagentType: row.subagentType,
  depth: row.depth,
  status: row.status,
  result: row.result,
  error: row.error,
  startedAt: row.startedAt,
  endedAt: row.endedAt
});

/** 收尾后台任务:进程启动时把上一轮崩溃遗留的 running 收成 failed。 */
export const failStaleTasks = (db: AppDatabase): number => {
  const result = db
    .update(backgroundTasks)
    .set({
      status: "failed",
      error: "server restarted while subagent task was in flight",
      endedAt: new Date().toISOString()
    })
    .where(eq(backgroundTasks.status, "running"))
    .run();

  return result.changes;
};

export class BackgroundTaskRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateBackgroundTaskInput): TaskRecord {
    this.db
      .insert(backgroundTasks)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        parentToolCallId: input.parentToolCallId,
        subagentType: input.subagentType,
        depth: input.depth,
        status: "running"
      })
      .run();

    return this.findById(input.id)!;
  }

  findById(taskId: string): TaskRecord | undefined {
    const row = this.db
      .select()
      .from(backgroundTasks)
      .where(eq(backgroundTasks.id, taskId))
      .get();

    return row ? toTaskRecord(row) : undefined;
  }

  /** settle:把一个运行中任务写终态。running 之外的重复 settle 无副作用(幂等)。 */
  settle(
    taskId: string,
    outcome: { readonly result?: string; readonly error?: string }
  ): TaskRecord {
    const status = outcome.error !== undefined ? "failed" : "done";
    const row = this.db
      .update(backgroundTasks)
      .set({
        status,
        ...(outcome.result !== undefined
          ? { result: outcome.result }
          : { result: null }),
        ...(outcome.error !== undefined ? { error: outcome.error } : { error: null }),
        endedAt: new Date().toISOString()
      })
      .where(eq(backgroundTasks.id, taskId))
      .returning()
      .get();

    // settle 不存在的 id:不该发生(Task 只 settle 自己 create 过的),throw 比静默好。
    if (!row) {
      throw new Error(`cannot settle unknown background task ${taskId}`);
    }

    return toTaskRecord(row);
  }
}
