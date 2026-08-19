import {
  canSpawnAtDepth,
  createReportTool,
  CrewRegistry,
  MAX_DEPTH,
  runSubagent,
  SUBAGENT_MAX_STEPS
} from "@eva/harness";
import type {
  AgentTool,
  ForkRunner,
  SubagentEventSink,
  SubagentNotice,
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
  /**
   * 子代理回报/收尾时的通知出口(S7 push)。route 把它接到 ReportGateway,
   * 主 loop 收尾前 drain 一次就能拿到 —— 模型不需要任何查询工具。
   */
  readonly onNotice?: ((notice: SubagentNotice) => void) | undefined;
}

/**
 * 一个 run 的子代理运行时:持 DB/任务上下文,把 subagent 工具的
 * runFork 翻译成「装配角色子代理 → 驱动 → 记录 → settle」。
 *
 * runFork 是唯一 create+settle 的边界(subagent 工具不碰 store 细节)。
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

  /** 前台 subagent 等待用 —— 路由用它喂 createSubagentTool。 */
  get store(): SqliteTaskStore {
    return this.taskStore;
  }

  /** 该 run 下是否还有存活的后台子代理(ReportGateway 据此决定要不要等)。 */
  hasLiveTasks(): boolean {
    return new BackgroundTaskRepository(this.options.db)
      .countRunningBySessionId(this.options.sessionId) > 0;
  }

  /** subagent 工具要的 fork 边界 —— 任务号由工具生成好传进来。 */
  readonly runFork: ForkRunner = async (input) => {
    const { background, prompt, subagentType, description, taskId, parentToolCallId } = input;

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
      description,
      depth: 0
    });

    // 前台派发的结果由工具返回值直达模型 —— 再推一条通知会让它把同一份内容
    // 读两遍(实测:第二条 assistant 只能说"这就是我刚转述的那份,一致")。
    // push 通道的存在意义正是"后台调用没有返回通道",所以只有后台才通知。
    const spawn = (): Promise<string> =>
      this.spawnSettled({
        role, taskId, parentToolCallId, description, prompt, notify: background
      });

    if (background) {
      // 后台:立刻带 taskId 返回,spawn 在后台跑(settle 稍后进 store)。
      void spawn().catch(async (error) => {
        const message = toErrorMessage(error);
        await this.taskStore.settle(taskId, { error: message });
        // 装配/驱动阶段就炸的 fork 也要通知父级 —— 否则模型只看到"已派出",
        // 然后永远等不到任何回音(实测下来这比报错更难排查)。
        this.notify({
          kind: "settled", taskId, parentToolCallId, subagentType, description,
          output: `Failed: ${message}`
        });
      });
      return { taskId };
    }

    // 前台:等子代理跑完,text 是最终答案(阀2:不含中间工具输出)。
    return { text: await spawn() };
  };

  private notify(notice: SubagentNotice): void {
    this.options.onNotice?.(notice);
  }

  private async spawnSettled(input: {
    readonly role: SubagentRole;
    readonly taskId: string;
    readonly parentToolCallId: string;
    readonly description: string;
    readonly prompt: string;
    /** 是否把 report/settled 推给父级(前台派发不推:工具返回值已经带回结果)。 */
    readonly notify: boolean;
  }): Promise<string> {
    const { role, taskId, parentToolCallId, description, prompt, notify } = input;

    // report 是子代理交付结论的唯一出口(S7 push)。每个 fork 一份闭包 ——
    // 它捕获自己的 taskId/挂点,子代理无从选择报给谁。
    const reports: string[] = [];
    const reportTool = createReportTool((output) => {
      reports.push(output);
      // 立刻推给父级:中途的发现也能马上改变父 agent 的下一步,不必等它跑完。
      if (notify) {
        this.notify({
          kind: "reported", taskId, parentToolCallId, subagentType: role.type,
          description, output
        });
      }
    });

    const agent = this.agents.buildSubagent({
      role,
      extraTools: [
        ...(this.options.extraTools ?? []),
        reportTool
      ],
      ...(this.options.workspace !== undefined
        ? { workspace: this.options.workspace }
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
    let streamError: string | undefined;

    await runSubagent({
      agent,
      taskId,
      parentToolCallId,
      subagentType: role.type,
      description,
      messages: [{ role: "user", content: prompt }],
      maxSteps: role.maxSteps ?? SUBAGENT_MAX_STEPS,
      ...(this.options.abortSignal !== undefined
        ? { abortSignal: this.options.abortSignal }
        : {}),
      onEvent: (event) => {
        if (event.event.type === "finish") lastText = event.event.text;
        // runSubagent 把异常吞成 error 事件(不抛),所以失败只能从这里看出来。
        // 不记下它,一个炸掉的子代理会被 settle 成 done + 空结果 —— 静默失败。
        if (event.event.type === "error") streamError = event.event.message;
        recorder.push(event.event);
        this.options.onSubagentEvent?.(event);
      }
    });

    recorder.flush();

    // 交付物优先取 report(子代理主动收敛的结论);没 report 才退回 finish 正文。
    const delivered = reports.length > 0 ? reports.join("\n\n") : lastText;

    if (streamError !== undefined) {
      await this.taskStore.settle(taskId, { error: streamError });
      if (notify) {
        this.notify({
          kind: "settled", taskId, parentToolCallId, subagentType: role.type,
          description, output: `Failed: ${streamError}`
        });
      }
      return delivered;
    }

    await this.taskStore.settle(taskId, { result: delivered });

    // 生命周期通知只在"它没 report 过"时才发。
    //
    // dsh 那边 settled 走 next-step(搭下一步的便车),reported 走 next-turn(唤起一轮);
    // 我们只有"注入即续跑一圈"一种粒度,所以已经报过的任务再补一条 settled 会让模型
    // 为同一个子代理白醒两次(实测:主链多出一条通知 + 一条空洞回应)。
    // 已 report → 结论已交付,"它结束了"不带新信息,不值得再唤起一圈。
    if (notify && reports.length === 0) {
      this.notify({
        kind: "settled", taskId, parentToolCallId, subagentType: role.type,
        description, output: lastText
      });
    }
    return delivered;
  }
}

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "subagent failed";
