import {
  SUBAGENT_ROLES,
  type AgentObserver,
  type AgentRunInput,
  type CanUseTool,
  type PipelineTool,
  type ForkRunner,
  type SubagentEventSink,
} from "@eva/harness";
import type { AppDatabase } from "../../db/index.js";
import { DrizzleMessageRepository } from "../sessions/index.js";
import { toRunStreamFrames } from "../runs/index.js";
import type { RunAgentStreamEvent, RunStreamEvent } from "@eva/shared";
import type { AgentFactory, ResolvedAgent, WorkspaceContext } from "../runs/index.js";
import { SubagentTaskRepository } from "./subagent-task-repository.js";
import { SubagentRecorder } from "./subagent-recorder.js";

export interface SubagentRunnerOptions {
  readonly toolExecutionForTask?: (taskId: string) => AgentRunInput["hooks"];
  readonly sessionId: string;
  readonly db: AppDatabase;
  readonly runId: string;
  readonly model: ResolvedAgent["toolModel"];
  readonly workspace?: WorkspaceContext;
  readonly extraTools?: readonly PipelineTool[];
  readonly abortSignal: AbortSignal;
  /** 与父 run 共用同一份权限链(同一个实例);子代理调用带 agentID = taskId。 */
  readonly canUseTool: CanUseTool;
  readonly observerForTask: (taskId: string) => AgentObserver;
  readonly onSubagentEvent?: SubagentEventSink;
}

/** A child is awaited by its tool call and cannot outlive that call's cancellation. */
export class SubagentRunner {
  constructor(private readonly agents: AgentFactory, private readonly options: SubagentRunnerOptions) { }

  readonly runFork: ForkRunner = async (input) => {
    const { taskId, parentToolCallId, description, prompt, subagentType } = input;
    const role = SUBAGENT_ROLES.find(role => role.type === subagentType);
    if (!role) throw new Error(`Unknown subagent type: ${subagentType}`);
    const signal = input.abortSignal ?? this.options.abortSignal;
    signal.throwIfAborted();
    const tasks = new SubagentTaskRepository(this.options.db);
    tasks.create({
      id: taskId, sessionId: this.options.sessionId,
      parentToolCallId, subagentType, description, depth: 0
    });
    const recorder = new SubagentRecorder(new DrizzleMessageRepository(this.options.db), {
      sessionId: this.options.sessionId, parentToolCallId,
      runId: this.options.runId, model: this.options.model.qualifiedModelId,
    }, prompt);
    let text = "";
    let error: string | undefined;
    let finished = false;
    try {
      const agent = this.agents.buildSubagent({
        role, model: this.options.model,
        observer: this.options.observerForTask(taskId),
        canUseTool: (toolName, input, options) =>
          this.options.canUseTool(toolName, input, { ...options, agentID: taskId }),
        ...(this.options.workspace ? { workspace: this.options.workspace } : {}),
        extraTools: [...(this.options.extraTools ?? [])],
      });
      for await (const message of agent.stream({
        messages: [{ role: "user", content: prompt }],
        abortSignal: signal,
        agentID: taskId,
        ...(this.options.toolExecutionForTask?.(taskId) !== undefined
          ? { hooks: this.options.toolExecutionForTask?.(taskId) }
          : {}),
      })) {
        // 一条消息流 → 帧:recorder 与 onSubagentEvent 吃帧(信封不变),
        // 子代理的终态从 result 消息读。
        for (const frame of toRunStreamFrames(message)) {
          recorder.push(frame);
          if (isAgentStreamEvent(frame)) {
            this.options.onSubagentEvent?.({ taskId, parentToolCallId, subagentType, description, event: frame });
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
