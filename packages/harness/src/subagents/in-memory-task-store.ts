import { randomUUID } from "node:crypto";
import type { CreateTaskInput, TaskRecord, TaskStore } from "./task-store.js";

type Resolve = (record: TaskRecord) => void;

/**
 * 内存版 TaskStore:测试与无 DB 场景用。notify 用 pending 订阅 + settle 时逐个 resolve
 * —— 和 SQLite 版同一个"DB 记事实 + 内存 deferred 通知"的思路,只是两端都在进程里。
 */
export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly waiters = new Map<string, Resolve[]>();

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const record: TaskRecord = {
      ...input,
      status: "running",
      result: null,
      error: null,
      startedAt: new Date().toISOString(),
      endedAt: null
    };
    this.tasks.set(record.id, record);
    return record;
  }

  async settle(taskId: string, outcome: { readonly result?: string; readonly error?: string }): Promise<void> {
    const current = this.tasks.get(taskId);
    if (!current) {
      return;
    }
    const resolved: TaskRecord = {
      ...current,
      status: outcome.error !== undefined ? "failed" : "done",
      result: outcome.result ?? null,
      error: outcome.error ?? null,
      endedAt: new Date().toISOString()
    };
    this.tasks.set(taskId, resolved);
    for (const resolve of this.waiters.get(taskId) ?? []) {
      resolve(resolved);
    }
    this.waiters.delete(taskId);
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    return this.tasks.get(taskId);
  }

  async waitFor(taskId: string, timeoutMs: number): Promise<TaskRecord | undefined> {
    const existing = this.tasks.get(taskId);
    if (!existing) {
      return undefined;
    }
    if (existing.status !== "running") {
      return existing;
    }
    return new Promise<TaskRecord>((resolve) => {
      const list = this.waiters.get(taskId) ?? [];
      list.push(resolve as Resolve);
      this.waiters.set(taskId, list);
      setTimeout(() => {
        const now = this.tasks.get(taskId);
        if (now) {
          resolve(now);
        }
      }, timeoutMs);
    });
  }
}
