/** Awaited 子代理任务的事实记录；transcript 存在 messages 表，这里不存第二份。 */
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
