import { and, asc, eq } from "drizzle-orm";
import type { AgentRunInput } from "@eva/harness";
import type { AppDatabase } from "../../db/index.js";
import { toolOperations } from "../../db/schema.js";

/** Synchronous SQLite writes: the intent is committed before execute starts. */
export function recordToolExecution(
  db: AppDatabase,
  runId: string,
  agent: string,
): NonNullable<AgentRunInput["onToolExecution"]> {
  return event => {
    if (event.type === "started") {
      db.insert(toolOperations).values({
        runId, agent, toolCallId: event.toolCallId, toolName: event.toolName,
        input: JSON.stringify(event.input) ?? "null", status: "running", startedAt: Date.now()
      }).run();
      return;
    }
    db.update(toolOperations).set({
      status: event.type === "completed" ? "completed" : "failed",
      ...(event.type === "completed" ? { output: JSON.stringify(event.output) ?? "null" } : { error: event.error }),
      endedAt: Date.now()
    }).where(and(
      eq(toolOperations.runId, runId),
      eq(toolOperations.agent, agent),
      eq(toolOperations.toolCallId, event.toolCallId),
    )).run();
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
