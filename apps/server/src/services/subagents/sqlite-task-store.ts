import type { CreateTaskInput, TaskRecord, TaskStore } from "@eva/harness";

import type { AppDatabase } from "../../db/index.js";
import { BackgroundTaskRepository } from "../../db/repositories/background-task-repository.js";

/** 一个在等某 taskId 终态的 waiter(进程内 deferred,不落库)。 */
type Waiter = (record: TaskRecord) => void;

/**
 * SQLite 版 TaskStore。
 *
 * 事实(create/settle/get)落 background_tasks 表 —— 重启后能 recover;waitFor
 * 的"完成通知"是进程内信号(settle 时逐个 resolve 等它的 waiter),DB 不存订阅。
 * 这样 join 不轮询,且超时/崩溃只影响进程内这次等待,事实仍在。
 */
export class SqliteTaskStore implements TaskStore {
  private readonly waiters = new Map<string, Waiter[]>();

  constructor(
    private readonly db: AppDatabase,
    private readonly tasks: BackgroundTaskRepository
  ) {}

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    return this.tasks.create(input);
  }

  async settle(
    taskId: string,
    outcome: { readonly result?: string; readonly error?: string }
  ): Promise<void> {
    const settled = this.tasks.settle(taskId, outcome);
    const waiters = this.waiters.get(taskId) ?? [];
    this.waiters.delete(taskId);
    for (const resolve of waiters) resolve(settled);
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    return this.tasks.findById(taskId);
  }

  async waitFor(taskId: string, timeoutMs: number): Promise<TaskRecord | undefined> {
    // 先注册 waiter 再做 DB 读:否则"调用 waitFor 后同 tick 就 settle"会看到空 waiter,
    // settle 白白 resolve 不了,只能吊到超时。注册必须与 settle 的读取同一同步阶段。
    return new Promise<TaskRecord | undefined>((resolve) => {
      const list = this.waiters.get(taskId) ?? [];
      list.push(resolve);
      this.waiters.set(taskId, list);

      const unregister = (): void => {
        const live = this.waiters.get(taskId) ?? [];
        const idx = live.indexOf(resolve);
        if (idx >= 0) live.splice(idx, 1);
        if (live.length === 0) this.waiters.delete(taskId);
      };

      // read 是同步的,先进来看一眼:已终态立刻给,不存在立刻 undefined,
      // running 则挂着等 settle —— 超时兜底回这个 running 快照(不重新查库,
      // 进程可能已把 DB 关了)。
      const current = this.tasks.findById(taskId);

      const timer = setTimeout(() => {
        unregister();
        resolve(current);
      }, timeoutMs);
      // 纯可弃的等待:settle 自会 resolve,别让这 timer 吊住进程。
      timer.unref?.();
      if (current === undefined) {
        clearTimeout(timer);
        unregister();
        resolve(undefined);
      } else if (current.status !== "running") {
        clearTimeout(timer);
        unregister();
        resolve(current);
      }
    });
  }
}
