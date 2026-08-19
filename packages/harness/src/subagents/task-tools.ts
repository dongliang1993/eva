import { z } from "zod";

import { buildTool, type AgentTool } from "../tools.js";
import type { TaskRecord, TaskStore } from "./task-store.js";
import type { SubagentEventSink } from "./types.js";

/** 一次 fork 交给 server 的最小面：子代理类型 + 唯一 prompt。其余装配全在 server。 */
export interface ForkInvocation {
  readonly taskId: string;
  readonly parentToolCallId: string;
  readonly subagentType: string;
  readonly prompt: string;
}

/**
 * server 层注入的 fork 边界(Step 4)。它知道 sessionId/depth/工具槽模型/角色白名单,
 * 所以 create(记事实) 和 settle(写终态) 都在这里 —— Task 工具只管编排(Missions)。
 * 返回 { 
 *  - background=true: 立刻带 taskId 返回(fork 已在后台跑)
 *  - background=false: 等跑完,text 是子代理最终答案(阀2:绝不含中间工具输出)
 * }
 */
export type ForkRunner = (invocation: {
  readonly background: boolean;
  readonly prompt: string;
  readonly subagentType: string;
  readonly taskId: string;
  readonly parentToolCallId: string;
}) => Promise<{ readonly taskId?: string; readonly text?: string }>;

export interface TaskToolContext {
  readonly taskStore: TaskStore;
  readonly runFork: ForkRunner;
  readonly joinTimeoutMs?: number;
  readonly onEvent?: SubagentEventSink;
}

const taskSchema = z.object({
  prompt: z.string().describe(
    "The task for the subagent to perform. Self-contained: it cannot see this conversation's " +
    "unspoken context, so everything it needs must be in this prompt."
  ),
  subagent: z.string().optional().describe("Subagent type to fork. Defaults to explorer."),
  background: z.boolean().optional().describe(
    "Default true: spawn and return a taskId immediately. false: block until it finishes, " +
    "return the final answer inline."
  )
});

const taskOutputSchema = z.object({
  taskId: z.string().describe("The taskId returned by an earlier background Task call."),
  block: z.boolean().optional().describe(
    "false (default): return current status. true: wait up to the join timeout; " +
    "if still running, return partial + a note."
  )
});

/**
 * Task / TaskOutput 两个 fork-join 基元(S7)。
 *
 * - Task(background 默认 true):后台派生子代理,立刻返回任务号;join 用 TaskOutput。
 * - TaskOutput(taskId, block=true):阻塞等完成或超时,把子代理最终答案作为工具输出返回;
 *   block=false 只查当前状态。
 *
 * 一个 fork 永远以 taskId 为句柄;TaskOutput 是唯一 join 通道。未知 taskId →
 * 可读错误(不静默吞)。中间工具步骤不进任何工具输出(阀2 的第二道保险)。
 */
export const createTaskTools = (ctx: TaskToolContext): readonly AgentTool[] => {
  const task = buildTool({
    name: "Task",
    description: [
      "Fork a subagent for a bounded, self-contained task.",
      "The subagent CANNOT see this conversation — everything it needs (context, constraints, " +
      "deliverable) MUST be in `prompt`.",
      "- background (default true): return the taskId; join later with TaskOutput.",
      "- background=false: block until finish, return the final text inline.",
      "The text you get back is the subagent's FINAL answer only — its intermediate tool steps " +
      "are not (and cannot be) brought into this context."
    ].join("\n"),
    schema: taskSchema,
    execute: async ({ prompt, subagent, background }) => {
      const id = newTaskId();
      const tcId = `task-${id}`;
      const result = await ctx.runFork({
        taskId: id,
        parentToolCallId: tcId,
        subagentType: subagent ?? "explorer",
        prompt,
        background: background !== false
      });
      if (background === false) {
        return result.text ?? `Task ${id} finished with no text.`;
      }
      return `Started subagent task ${id}. Join it with TaskOutput(taskId="${id}", block=true).`;
    }
  });

  const taskOutput = buildTool({
    name: "TaskOutput",
    description: [
      "Join a background subagent task from Task(background=true).",
      "block=true: wait up to the join timeout for completion; returns final text, or partial " +
      "output + a 'still running' note if the timeout hits first (you may join again later).",
      "block=false: return the current status without waiting.",
      "Returns a readable error for an unknown taskId (it may be from an aborted/earlier run)."
    ].join("\n"),
    schema: taskOutputSchema,
    execute: async ({ taskId, block }) => {
      const record = await ctx.taskStore.get(taskId);
      if (!record) {
        return `[Task Error] Unknown taskId "${taskId}". It may be from an aborted/older run — ` +
          "join with a taskId returned by a Task call in THIS run.";
      }
      if (!block) {
        return formatStatus(record);
      }
      const waited = await ctx.taskStore.waitFor(taskId, ctx.joinTimeoutMs ?? 120_000);
      return formatStatus(waited ?? record);
    }
  });

  return [task, taskOutput];
};

/** 工具内本地生成 fork 号 —— server 会用它做 create 的 id。 */
const newTaskId = (): string => {
  const rand = Math.random().toString(36).slice(2, 10);
  return `t_${Date.now().toString(36)}_${rand}`;
};

const formatStatus = (record: TaskRecord): string => {
  switch (record.status) {
    case "running":
      return `Task ${record.id} still running (started ${record.startedAt})`;
    case "done":
      return record.result ?? `Task ${record.id} finished (no result)`;
    case "failed":
      return `[Task Error] ${record.error ?? "subagent failed"}`;
  }
};
