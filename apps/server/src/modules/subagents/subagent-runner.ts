import {
  SUBAGENT_ROLES,
  type AgentObserver,
  type AgentRunInput,
  type AgentTool,
  type ForkRunner,
  type RequestApproval,
  type SubagentEventSink,
} from "@eva/harness";
import type { AppDatabase } from "../../db/index.js";
import { DrizzleMessageRepository } from "../sessions/index.js";
import type { AgentFactory, ResolvedAgent, WorkspaceContext } from "../runs/index.js";
import { SubagentTaskRepository } from "./subagent-task-repository.js";
import { SubagentRecorder } from "./subagent-recorder.js";

export interface SubagentRunnerOptions {
  readonly toolExecutionForTask?: (taskId: string) => AgentRunInput["onToolExecution"];
  readonly sessionId: string;
  readonly db: AppDatabase;
  readonly runId: string;
  readonly model: ResolvedAgent["toolModel"];
  readonly workspace?: WorkspaceContext;
  readonly extraTools?: readonly AgentTool[];
  readonly abortSignal: AbortSignal;
  readonly requestApproval: RequestApproval;
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
        requestApproval: this.options.requestApproval,
        ...(this.options.workspace ? { workspace: this.options.workspace } : {}),
        extraTools: [...(this.options.extraTools ?? [])],
      });
      for await (const event of agent.stream({
        messages: [{ role: "user", content: prompt }],
        abortSignal: signal,
        onToolExecution: this.options.toolExecutionForTask?.(taskId),
      })) {
        recorder.push(event);
        this.options.onSubagentEvent?.({ taskId, parentToolCallId, subagentType, description, event });
        if (event.type === "finish") {
          finished = true;
          text = event.text;
          if (event.finishReason !== "stop") error = `Subagent ended: ${event.finishReason}`;
        }
        if (event.type === "error") error = event.message;
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
