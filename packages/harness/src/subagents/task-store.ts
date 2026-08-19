/** 后台任务的事实记录。transcript 存在 messages 表,这里不存第二份(docs 14 §7.2 偏离)。 */
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

export interface CreateTaskInput {
  readonly id: string;
  readonly sessionId: string;
  readonly parentToolCallId: string;
  readonly subagentType: string;
  readonly description: string;
  readonly depth: number;
}

/** 进程内任务信箱 —— harness 定契约,server 用 SQLite+deferred 实现。 */
export interface TaskStore {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  settle(taskId: string, outcome: { readonly result?: string; readonly error?: string }): Promise<void>;
  get(taskId: string): Promise<TaskRecord | undefined>;
  /**
   * 等到终态或超时。超时返回当前记录(status 仍是 running) —— 由调用方决定
   * 给模型 partial 还是继续等。JOIN_TIMEOUT_MS 是硬上限,防子代理死循环吊死主 agent。
   */
  waitFor(taskId: string, timeoutMs: number): Promise<TaskRecord | undefined>;
}
