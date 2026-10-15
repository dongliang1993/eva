import type { HarnessMessage } from "@eva/harness";
import type { RunAgentStreamEvent, RunStreamEvent } from "@eva/shared";

import type { AppDatabase } from "../../db/index.js";
import { DrizzleMessageRepository } from "../sessions/index.js";
import { toRunStreamFrames } from "../runs/index.js";
import { SubagentTaskRepository } from "./subagent-task-repository.js";
import { SubagentRecorder } from "./subagent-recorder.js";

/**
 * 子代理消息的 server 投影 —— harness 的内置 subagent 工具跑子代理,
 * 它的消息并在主 query() 流里(Claude Code 同款:task_started → 子代理消息
 * (parent_tool_use_id = 派发调用)→ task_notification)。这里按 parent_tool_use_id 分拣:
 *
 *   task_started       → subagent_tasks 建行 + 开 recorder / 轨迹
 *   子代理消息          → 帧 → recorder(落库)+ subagent_update(SSE)+ 轨迹(agent = taskId)
 *   task_notification  → recorder 封口 + 任务结算(同一事务)
 *
 * 主 agent 的消息不经过这里(accepts() 为 false)。
 */

export interface SubagentProjectionOptions {
  readonly db: AppDatabase;
  readonly sessionId: string;
  readonly runId: string;
  /** 子代理消息的 metadata.model(工具槽位模型)。 */
  readonly model: string;
  /** 子代理的轨迹(run_events,agent = taskId)。 */
  readonly trajectoryForTask: (taskId: string) => { record(message: HarnessMessage): void };
  /** SSE subagent_update 的出口(信封不变)。 */
  readonly emit: (event: RunStreamEvent) => void;
}

interface ActiveTask {
  readonly taskId: string;
  readonly subagentType: string;
  readonly description: string;
  readonly recorder: SubagentRecorder;
  readonly trajectory: { record(message: HarnessMessage): void };
}

export interface SubagentProjection {
  /** 这条消息归子代理(子代理消息或 task_* 起止)。 */
  accepts(message: HarnessMessage): boolean;
  record(message: HarnessMessage): void;
  /** run 结束时仍未收到 task_notification 的任务(异常路径)收成 failed。 */
  settleOrphans(reason: string): void;
}

/** 消息分拣器
 ** harness 的内置 subagent 工具跑子代理时，子代理的消息不会开一条独立的流，
 ** 而是并回父 query() 的同一条消息流，靠 parent_tool_use_id(派发那次工具调用的 id)标记“这条是那个子代理产生的”。
 ** 系统还会插两条生命周期消息:task_started(派发了)和 task_notification(子代理跑完了)。
*/
export const createSubagentProjection = (
  options: SubagentProjectionOptions,
): SubagentProjection => {
  const tasks = new SubagentTaskRepository(options.db);
  const messages = new DrizzleMessageRepository(options.db);
  // key = 派发调用的 toolUseID(= 子代理消息的 parent_tool_use_id)
  const active = new Map<string, ActiveTask>();

  const start = (message: Extract<HarnessMessage, { subtype: "task_started" }>): void => {
    tasks.create({
      id: message.task_id,
      sessionId: options.sessionId,
      parentToolCallId: message.tool_use_id,
      subagentType: message.task_type,
      description: message.description,
      depth: 0,
    });
    active.set(message.tool_use_id, {
      taskId: message.task_id,
      subagentType: message.task_type,
      description: message.description,
      recorder: new SubagentRecorder(messages, {
        sessionId: options.sessionId,
        parentToolCallId: message.tool_use_id,
        runId: options.runId,
        model: options.model,
      }, message.prompt),
      trajectory: options.trajectoryForTask(message.task_id),
    });
  };

  const finish = (
    toolUseID: string,
    outcome: { readonly result?: string; readonly error?: string },
  ) => {
    const task = active.get(toolUseID);
    if (task === undefined) return;

    active.delete(toolUseID);
    options.db.transaction(() => {
      task.recorder.flush();
      tasks.settle(task.taskId, outcome);
    });
  };

  const project = (task: ActiveTask, toolUseID: string, message: HarnessMessage): void => {
    task.trajectory.record(message);
    for (const frame of toRunStreamFrames(message)) {
      task.recorder.push(frame);
      if (isAgentStreamEvent(frame)) {
        options.emit({
          type: "subagent_update",
          taskId: task.taskId,
          parentToolCallId: toolUseID,
          subagentType: task.subagentType,
          description: task.description,
          event: frame,
        });
      }
    }
  };

  return {
    accepts: (message) => {
      return message.parent_tool_use_id !== null ||
        (message.type === "system" &&
          (message.subtype === "task_started" || message.subtype === "task_notification"))
    },

    record(message) {
      if (message.type === "system" && message.subtype === "task_started") {
        start(message);
        return;
      }

      if (message.type === "system" && message.subtype === "task_notification") {
        finish(
          message.tool_use_id,
          message.status === "completed"
            ? { result: message.summary }
            : { error: message.summary },
        );
        return;
      }

      const toolUseID = message.parent_tool_use_id;
      if (toolUseID === null) return;
      const task = active.get(toolUseID);
      if (task !== undefined) project(task, toolUseID, message);
    },

    settleOrphans(reason) {
      for (const toolUseID of [...active.keys()]) {
        finish(toolUseID, { error: reason });
      }
    },
  };
};

/** agent 域帧判别(subagent_update 信封只装 agent 域帧)。 */
const isAgentStreamEvent = (event: RunStreamEvent): event is RunAgentStreamEvent =>
  event.type === "text-delta" ||
  event.type === "reasoning-delta" ||
  event.type === "tool-input-start" ||
  event.type === "tool-input-delta" ||
  event.type === "tool-call" ||
  event.type === "tool-result" ||
  event.type === "step-start" ||
  event.type === "finish" ||
  event.type === "error";
