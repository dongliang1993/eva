import { and, eq } from "drizzle-orm";


import type { AppDatabase } from "../../db/index.js";

/** Awaited 子代理任务的事实记录;transcript 存在 messages 表,这里不存第二份。 */
export interface TaskRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly parentToolCallId: string;
  readonly subagentType: string;
  /** subagent 工具给的 3-5 词任务名(旧任务为空串)。 */
  readonly description: string;
  readonly depth: number;
  readonly status: "running" | "done" | "failed";
  readonly result: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}
import { subagentTasks } from "../../db/schema.js";

export interface CreateSubagentTaskInput {
  readonly id: string;
  readonly sessionId: string;
  readonly parentToolCallId: string;
  readonly subagentType: string;
  readonly description: string;
  readonly depth: number;
}

/** subagent_tasks 表的行级读写。 */
const toTaskRecord = (row: typeof subagentTasks.$inferSelect): TaskRecord => ({
  id: row.id,
  sessionId: row.sessionId,
  parentToolCallId: row.parentToolCallId,
  description: row.description,
  subagentType: row.subagentType,
  depth: row.depth,
  status: row.status,
  result: row.result,
  error: row.error,
  startedAt: row.startedAt,
  endedAt: row.endedAt
});

/** 进程启动时把崩溃遗留的 running 子代理任务收成 failed。 */
export const failStaleTasks = (db: AppDatabase): number => {
  const result = db
    .update(subagentTasks)
    .set({
      status: "failed",
      error: "server restarted while subagent task was in flight",
      endedAt: new Date().toISOString()
    })
    .where(eq(subagentTasks.status, "running"))
    .run();

  return result.changes;
};

export class SubagentTaskRepository {
  constructor(private readonly db: AppDatabase) { }

  create(input: CreateSubagentTaskInput): TaskRecord {
    this.db
      .insert(subagentTasks)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        parentToolCallId: input.parentToolCallId,
        subagentType: input.subagentType,
        description: input.description,
        depth: input.depth,
        status: "running"
      })
      .run();

    return this.findById(input.id)!;
  }

  findById(taskId: string): TaskRecord | undefined {
    const row = this.db
      .select()
      .from(subagentTasks)
      .where(eq(subagentTasks.id, taskId))
      .get();

    return row ? toTaskRecord(row) : undefined;
  }

  /** 按 toolCallId 挂点取任务 —— `/subagent-messages` 路由用 toolCallId 定位任务。 */
  findByParentToolCallId(parentToolCallId: string): TaskRecord | undefined {
    const row = this.db
      .select()
      .from(subagentTasks)
      .where(eq(subagentTasks.parentToolCallId, parentToolCallId))
      .get();

    return row ? toTaskRecord(row) : undefined;
  }

  /** settle: 把一个运行中任务写终态。running 之外的重复 settle 无副作用(幂等)。 */
  settle(
    taskId: string,
    outcome: { readonly result?: string; readonly error?: string }
  ): TaskRecord {
    const status = outcome.error !== undefined ? "failed" : "done";
    const row = this.db
      .update(subagentTasks)
      .set({
        status,
        ...(outcome.result !== undefined
          ? { result: outcome.result }
          : { result: null }),
        ...(outcome.error !== undefined ? { error: outcome.error } : { error: null }),
        endedAt: new Date().toISOString()
      })
      .where(and(eq(subagentTasks.id, taskId), eq(subagentTasks.status, "running")))
      .returning()
      .get();

    // settle 不存在的 id:不该发生(Task 只 settle 自己 create 过的),throw 比静默好。
    if (!row) {
      const existing = this.findById(taskId);
      if (existing) return existing;
      throw new Error(`cannot settle unknown subagent task ${taskId}`);
    }

    return toTaskRecord(row);
  }
}
