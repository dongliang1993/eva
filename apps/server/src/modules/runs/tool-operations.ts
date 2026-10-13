import { and, asc, eq } from "drizzle-orm";
import type { HookCallback, HookCallbackMatcher, Options } from "@eva/harness";
import type { AppDatabase } from "../../db/index.js";
import { toolOperations } from "../../db/schema.js";

/**
 * tool_operations 的写入改由 hooks 完成(FR-008):
 * intent 在 PreToolUse(权限通过后、execute 前 —— 被拒的调用不写 intent),
 * result 在 PostToolUse / PostToolUseFailure。
 * Synchronous SQLite writes: the intent is committed before execute starts.
 */
export function toolOperationHooks(
  db: AppDatabase,
  runId: string,
  agent: string,
): NonNullable<Options["hooks"]> {
  const pre: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    db.insert(toolOperations).values({
      runId, agent, toolCallId: input.tool_use_id, toolName: input.tool_name,
      input: JSON.stringify(input.tool_input) ?? "null", status: "running", startedAt: Date.now()
    }).run();
    return {};
  };
  const post: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    db.update(toolOperations).set({
      status: "completed",
      output: JSON.stringify(input.tool_response) ?? "null",
      endedAt: Date.now()
    }).where(and(
      eq(toolOperations.runId, runId),
      eq(toolOperations.agent, agent),
      eq(toolOperations.toolCallId, input.tool_use_id),
    )).run();
    return {};
  };
  const postFailure: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUseFailure") return {};
    db.update(toolOperations).set({
      status: "failed",
      error: input.error,
      endedAt: Date.now()
    }).where(and(
      eq(toolOperations.runId, runId),
      eq(toolOperations.agent, agent),
      eq(toolOperations.toolCallId, input.tool_use_id),
    )).run();
    return {};
  };
  return {
    PreToolUse: [{ hooks: [pre] }],
    PostToolUse: [{ hooks: [post] }],
    PostToolUseFailure: [{ hooks: [postFailure] }],
  };
}

export function interruptToolExecutions(db: AppDatabase): void {
  db.update(toolOperations).set({ status: "unknown", endedAt: Date.now(),
    error: "Server restarted before an execution result was recorded; do not automatically replay."
  }).where(eq(toolOperations.status, "running")).run();
}

export function listToolExecutions(db: AppDatabase, runId: string) {
  return db.select().from(toolOperations).where(eq(toolOperations.runId, runId))
    .orderBy(asc(toolOperations.startedAt), asc(toolOperations.agent), asc(toolOperations.toolCallId)).all()
    .map(row => ({ ...row, input: JSON.parse(row.input) as unknown,
      output: row.output === null ? null : JSON.parse(row.output) as unknown }));
}
