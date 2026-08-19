import {
  canSpawnAtDepth,
  CrewRegistry,
  MAX_DEPTH,
  runSubagent,
  SUBAGENT_MAX_STEPS
} from "@eva/harness";
import type {
  AgentTool,
  ForkRunner,
  SubagentEventSink,
  SubagentRole
} from "@eva/harness";

import type { AppDatabase } from "../../db/index.js";
import { BackgroundTaskRepository } from "../../db/repositories/background-task-repository.js";
import type { IMessageRepository } from "../../db/repositories/types.js";
import type { ResolvedWorkspaceContext } from "../../agent.js";
import type { AgentFactory } from "../agent-factory.js";
import { SqliteTaskStore } from "./sqlite-task-store.js";
import { SubagentRecorder } from "./subagent-recorder.js";

export interface SubagentRunnerOptions {
  readonly sessionId: string;
  readonly db: AppDatabase;
  readonly runId?: string | undefined;
  readonly model?: string | undefined;
  /** 本轮工作区(角色白名单照它过滤真实工具)。 */
  readonly workspace?: ResolvedWorkspaceContext | undefined;
  /** 进程级外部工具(MCP) —— 子代理按角色从此收窄。 */
  readonly extraTools?: readonly AgentTool[] | undefined;
  /** 后台子代理共享 run 的 AbortSignal —— 用户点停止,子代理一起停(T15 §2.7)。 */
  readonly abortSignal?: AbortSignal | undefined;
  readonly onSubagentEvent?: SubagentEventSink | undefined;
}

/**
 * 一个 run 的子代理运行时:持 DB/任务上下文,把 Task/TaskOutput 工具的
 * runFork 翻译成「装配角色子代理 → 驱动 → 记录 → settle」。
 *
 * runFork 是唯一 create+settle 的边界(Task 工具不碰 store 细节)。
 * 角色/深度在 fork 期解析:解析不出立刻抛,绝不静默降级。
 */
export class SubagentRunner {
  private readonly taskStore: SqliteTaskStore;
  private readonly crew = new CrewRegistry();

  constructor(
    private readonly agents: AgentFactory,
    private readonly messages: IMessageRepository,
    private readonly options: SubagentRunnerOptions
  ) {
    this.taskStore = new SqliteTaskStore(
      options.db,
      new BackgroundTaskRepository(options.db)
    );
  }

  /** Task/TaskOutput 工具经它 join/查询 —— 路由用它喂 createTaskTools。 */
  get store(): SqliteTaskStore {
    return this.taskStore;
  }

  /** Task/TaskOutput 工具要的 fork 边界 —— 任务号由 Task 工具生成好传进来。 */
  readonly runFork: ForkRunner = async (input) => {
    const { background, prompt, subagentType, taskId, parentToolCallId } = input;

    // 装配期解析角色:拿不到 = 配置错误,立刻抛,不静默少工具。
    const role = this.crew.get(subagentType);
    if (!role) {
      throw new Error(`unknown subagent type: ${subagentType}`);
    }

    // 深度闸单独判:一个不该递归的子代理就不该被 spawn(docs 08 §6.2 的 depth 边)。
    if (!canSpawnAtDepth(0)) {
      throw new Error(`subagent depth exceeded (max ${MAX_DEPTH})`);
    }

    // 声明要落事实:先 create(running)。失败(重复 id 等)→ 早爆,不碰后续。
    await this.taskStore.create({
      id: taskId,
      sessionId: this.options.sessionId,
      parentToolCallId,
      subagentType,
      depth: 0
    });

    const spawn = (): Promise<string> =>
      this.spawnSettled({ role, taskId, parentToolCallId, prompt });

    if (background) {
      // 后台:立刻带 taskId 返回,spawn 在后台跑(settle 稍后进 store)。
      void spawn().catch(async (error) => {
        await this.taskStore.settle(taskId, { error: toErrorMessage(error) });
      });
      return { taskId };
    }

    // 前台:等子代理跑完,text 是最终答案(阀2:不含中间工具输出)。
    return { text: await spawn() };
  };

  private async spawnSettled(input: {
    readonly role: SubagentRole;
    readonly taskId: string;
    readonly parentToolCallId: string;
    readonly prompt: string;
  }): Promise<string> {
    const { role, taskId, parentToolCallId, prompt } = input;

    const agent = this.agents.buildSubagent({
      role,
      ...(this.options.workspace !== undefined
        ? { workspace: this.options.workspace }
        : {}),
      ...(this.options.extraTools !== undefined
        ? { extraTools: this.options.extraTools }
        : {})
    });

    const recorder = new SubagentRecorder(
      this.messages,
      {
        sessionId: this.options.sessionId,
        parentToolCallId,
        ...(this.options.runId !== undefined ? { runId: this.options.runId } : {}),
        ...(this.options.model !== undefined ? { model: this.options.model } : {})
      },
      prompt
    );

    let lastText = "";

    await runSubagent({
      agent,
      taskId,
      parentToolCallId,
      subagentType: role.type,
      messages: [{ role: "user", content: prompt }],
      maxSteps: role.maxSteps ?? SUBAGENT_MAX_STEPS,
      ...(this.options.abortSignal !== undefined
        ? { abortSignal: this.options.abortSignal }
        : {}),
      onEvent: (event) => {
        if (event.event.type === "finish") lastText = event.event.text;
        recorder.push(event.event);
        this.options.onSubagentEvent?.(event);
      }
    });

    recorder.flush();
    await this.taskStore.settle(taskId, { result: lastText });
    return lastText;
  }
}

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "subagent failed";
