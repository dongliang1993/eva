import {
  query,
  type CanUseTool,
  type Options,
  type PipelineTool,
} from "@eva/harness";
import type { AppDatabase } from "../../db/index.js";
import { DrizzleMessageRepository } from "../sessions/index.js";
import { SUBAGENT_ROLES } from "./index.js";
import { toRunStreamFrames } from "../runs/index.js";
import type { RunAgentStreamEvent, RunStreamEvent } from "@eva/shared";
import type { AgentFactory, WorkspaceContext } from "../runs/index.js";
import type { ModelBinding } from "../providers/index.js";
import { SubagentTaskRepository } from "./subagent-task-repository.js";
import { SubagentRecorder } from "./subagent-recorder.js";

/** 子代理任务在流里派发时的输入(harness 的 subagent 工具调用参数)。 */
export interface SubagentRunnerOptions {
  readonly sessionId: string;
  readonly db: AppDatabase;
  readonly runId: string;
  /** 主代理装配时解析的 tool 槽位 binding(子代理用它,不走 chat)。 */
  readonly model: ModelBinding;
  readonly workspace?: WorkspaceContext;
  readonly extraTools?: readonly PipelineTool[];
  readonly abortSignal: AbortSignal;
  /** 与父 run 共用同一份权限链(同一个实例);子代理调用带 agentID = taskId。 */
  readonly canUseTool: CanUseTool;
  /** 子代理的 hooks(台账等),按 taskId 注入。 */
  readonly hooksForTask: (taskId: string) => NonNullable<Options["hooks"]>;
  /** 子代理终态写入 run_events 的通道(轨迹页)。 */
  readonly trajectoryForTask: (taskId: string) => { record(message: import("@eva/harness").HarnessMessage): void };
  /** SSE subagent_update 帧的出口(信封不变)。 */
  readonly onSubagentEvent: (event: SubagentStreamEvent) => void;
}

/** 与旧 SubagentEvent 同形(信封):taskId 归属、事件域帧。 */
export interface SubagentStreamEvent {
  readonly taskId: string;
  readonly parentToolCallId: string;
  readonly subagentType: string;
  readonly description: string;
  readonly event: RunAgentStreamEvent;
}

/**
 * 子代理 = awaited 工具:一条 query() 流 → 帧投影(recorder / SSE / 轨迹)。
 * A child is awaited by its tool call and cannot outlive that call's cancellation.
 */
export class SubagentRunner {
  constructor(private readonly agents: AgentFactory, private readonly options: SubagentRunnerOptions) { }

  readonly runFork = async (input: {
    readonly taskId: string;
    readonly parentToolCallId: string;
    readonly subagentType: string;
    readonly description: string;
    readonly prompt: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<{ readonly text: string }> => {
    const { taskId, parentToolCallId, subagentType, description, prompt } = input;
    const role = SUBAGENT_ROLES.find((r) => r.type === subagentType);
    if (!role) throw new Error(`Unknown subagent type: ${subagentType}`);
    const signal = input.abortSignal ?? this.options.abortSignal;
    signal.throwIfAborted();

    const tasks = new SubagentTaskRepository(this.options.db);
    tasks.create({
      id: taskId, sessionId: this.options.sessionId,
      parentToolCallId, subagentType, description, depth: 0,
    });
    const recorder = new SubagentRecorder(new DrizzleMessageRepository(this.options.db), {
      sessionId: this.options.sessionId, parentToolCallId,
      runId: this.options.runId,
      model: this.options.model.qualifiedModelId,
    }, prompt);
    const trajectory = this.options.trajectoryForTask(taskId);

    let text = "";
    let error: string | undefined;
    let finished = false;
    try {
      const options = this.agents.buildSubagentOptions({
        role,
        systemPrompt: role.systemPrompt,
        maxTurns: role.maxSteps ?? 50,
        model: this.options.model,
        canUseTool: (toolName, toolInput, permissionOptions) =>
          this.options.canUseTool(toolName, toolInput, {
            ...permissionOptions,
            agentID: taskId,
          }),
        ...(this.options.workspace ? { workspace: this.options.workspace } : {}),
        extraTools: [...(this.options.extraTools ?? [])],
      });
      const child = query({
        prompt: [{ role: "user", content: prompt }],
        options: {
          ...options,
          // 同一 run 的 hook/轨迹:子代理的 hook 由 server 按 taskId 注入。
          hooks: this.options.hooksForTask(taskId),
        },
      });
      for await (const message of child) {
        trajectory.record(message);
        // 一条消息流 → 帧:recorder 与 onSubagentEvent 吃帧(信封不变),
        // 子代理的终态从 result 消息读。
        for (const frame of toRunStreamFrames(message)) {
          recorder.push(frame);
          if (isAgentStreamEvent(frame)) {
            this.options.onSubagentEvent({ taskId, parentToolCallId, subagentType, description, event: frame });
          }
          if (frame.type === "finish") {
            finished = true;
            text = frame.text;
            if (frame.finishReason !== "stop") error = `Subagent ended: ${frame.finishReason}`;
          }
          if (frame.type === "error") error = frame.message;
        }
      }
      if (!finished && !error) error = "Subagent stream ended without a terminal outcome";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    this.options.db.transaction(() => {
      recorder.flush();
      tasks.settle(taskId, error ? { error } : { result: text });
    });
    if (error) throw new Error(error);
    return { text };
  };
}

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
