import { randomUUID } from "node:crypto";

import type { AgentObserver, Skill } from "@eva/harness";
import type { RunStreamEvent } from "@eva/shared";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import type { RunFailureLayer } from "../../db/schema.js";
import type { AgentFactory } from "./agent-factory.js";
import type {
  ApprovalGateway,
  ApprovalPolicyStore,
} from "../approvals/index.js";
import type { McpRegistry } from "../mcp/index.js";
import type { PlanWeaveService } from "../plan-weave/index.js";
import type { DrizzleMessageRepository } from "../sessions/index.js";
import type { DrizzlePlanRepository } from "../plan-gate/index.js";
import type { DrizzleRunRepository } from "./run-repository.js";
import type { DrizzleSessionRepository } from "../sessions/index.js";
import type { RunRegistry } from "./run-registry.js";
import type { SessionService } from "../sessions/index.js";
import { loadAppSettings } from "../settings/index.js";
import type { ReportGateway } from "../subagents/index.js";
import type { WorkspaceStore } from "../workspaces/index.js";
import type { RunEventStream } from "../../transports/sse/event-stream.js";
import { runRequestSchema } from "../../types/runs.js";
import { AssistantMessageRecorder } from "./assistant-message-recorder.js";
import { RunApprovalChannel } from "./run-approval-channel.js";
import type { RunFailurePhase, RunFinalizerFactory } from "./run-finalizer.js";
import type { RunHub } from "./run-hub.js";
import type { RunOpeningLedger } from "./run-ledger.js";
import {
  prepareRunContext,
  prepareRunInput,
  SessionBusyError,
  type RunInput,
  type RunPreparationDependencies
} from "./run-preparation.js";
import { RunRuntimeBuilder, type RunRuntimeScope } from "./run-runtime-builder.js";

export interface RunCoordinatorDependencies {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  /**
   * 进程级 logger(装配与准备阶段用);每请求的 logger 由 run() 的参数带进来。
   * 只声明真正用到的那一个级别 —— 别写成 pino 的 Logger,那会把 Fastify 的
   * FastifyBaseLogger 挡在外面(实测编译不过),而这里根本用不到 pino 的全部能力。
   */
  readonly logger: { warn(object: unknown, message?: string): void };
  readonly skills: readonly Skill[];
  readonly baseObserver: AgentObserver | undefined;
  readonly agents: AgentFactory;
  readonly session: SessionService;
  readonly approvals: ApprovalGateway;
  readonly approvalPolicies: ApprovalPolicyStore;
  /**
   * 只给 Open 阶段的两个方法。**编译器在这里替代 lint**:coordinator 看不见
   * settle / fail,所以「在某个 catch 里顺手写一句 runLedger.fail」这件事编译不过
   * (实测:TS2339 Property 'settle' does not exist on type 'RunOpeningLedger')。
   */
  readonly runLedger: RunOpeningLedger;
  /**
   * 终态的构造权在组合根手里 —— coordinator 只能「要一个 finalizer」,不能自己 new。
   * 自己 new 就等于手里出现了 RunSettlingLedger,上面那条收窄立刻白做。
   */
  readonly createFinalizer: RunFinalizerFactory;
  readonly runRegistry: RunRegistry;
  readonly workspaces: WorkspaceStore;
  readonly planWeave: PlanWeaveService;
  readonly mcp: McpRegistry;
  /** 阶段①要读会话/消息/在飞 run —— 由组合根注入,不在这里现建(§10.2 第 3 条)。 */
  readonly sessions: DrizzleSessionRepository;
  readonly messages: DrizzleMessageRepository;
  readonly runs: DrizzleRunRepository;
  readonly plans: DrizzlePlanRepository;
}

/** run() 需要的每请求日志口 —— 只用到这三个级别。 */
export interface RunRequestLog {
  info(object: unknown, message?: string): void;
  warn(object: unknown, message?: string): void;
  error(object: unknown, message?: string): void;
}

/**
 * 一次 Run 的结局,**按「route 还能不能回 HTTP 状态码」分类** —— 不是按成功/失败分类。
 *
 * - `streamed`:SSE 通道已经开过,收尾(含错误)已经从流里告知过了。route 无事可做。
 * - `rejected`:流还没开就失败了,头没发出去 —— route 把 error 映射成 409/503/400。
 *   台账已经收好(finalizer.fail 跑过了),route 只做协议翻译。
 */
export type RunOutcome =
  | { readonly kind: "streamed" }
  | { readonly kind: "rejected"; readonly error: unknown };

/**
 * 一次 Run 的作用域 —— 那些「只有这次 run 有、且要活到 finally」的可变事实。
 *
 * 不单独成文件:只有 coordinator 一个使用者(§7.2)。涨过 80 行或出现第二个使用者时再拆。
 * 它存在的意义是让 finally 里那几行有明确的读取对象 —— 在此之前它们读的是
 * handler 里七个散落的 let。
 */
class RunScope {
  /** 阶段①之前为空串 —— 那时连会话都没有,失败也没有台账行要收。 */
  sessionId = "";
  /** 阶段①的产出。503 回滚要读它的 createdSessionId。 */
  input: RunInput | undefined;
  /**
   * T48:流式**开始前**失败的层。"routing" = provider/模型/skill 解析;
   * "context" = prepareRunContext(compact/历史转换);undefined = 已进入流式
   * (归因走 T49 的事件层,不在 catch 里猜)。
   */
  phase: RunFailurePhase | undefined;
  /**
   * T49:run_failed / max-steps 事件带的失败层(agent.ts 发出,observer 桥回填)。
   * 是 ref 而不是值:收尾时才读,那时它可能已经被运行期填过了。
   */
  readonly failureLayer: { current?: RunFailureLayer } = {};
  /** 与 run 同寿。装配抛错时可能压根没建,所以 finally 里要判空。 */
  reportGateway: ReportGateway | undefined;
  /**
   * SSE 头发出去了没有。等价于 `reply.raw.headersSent`(这个 handler 里只有
   * `stream.open()` 会写头),但由自己记账 —— coordinator 不需要认识 Fastify 的 reply。
   */
  streamOpened = false;

  constructor(
    readonly runId: string,
    readonly controller: AbortController,
    readonly hub: RunHub
  ) {}

  /** 扇出而不是直写:重连上来的订阅者也要收到后续的帧。 */
  readonly emit = (event: RunStreamEvent): void => this.hub.publish(event);
}

/**
 * Run 的编排顺序 —— **这个文件里只有顺序**。
 *
 * 装配去了 run-runtime-builder,审批去了 run-approval-channel,终态去了 run-finalizer,
 * 协议翻译留在本模块 route.ts。剩下这里的是「五个阶段按什么次序发生、各自的前置是什么」,
 * 也就是 §5.0 那张表想让人一口气读完的东西。
 *
 * 五个阶段(注释里标了 ①-⑤,顺序不能动的地方各自写明理由):
 *   ① 输入   会话/用户消息/工作区/模型落定 + 开台账行
 *   ② 装配   这轮 agent 能用什么(skill / 记忆 / plan gate / 工具 / 模型)
 *   ③ 上下文 模型这轮看见什么(要 ② 的 mainModel 窗口信息)
 *   ④ 开流   SSE 头 + run_start + 子代理运行时(要连接可推帧)
 *   ⑤ 流式   13 行 for-await,然后 finalizer 收尾
 */
export class RunCoordinator {
  private readonly preparation: RunPreparationDependencies;
  private readonly builder: RunRuntimeBuilder;

  constructor(private readonly deps: RunCoordinatorDependencies) {
    this.preparation = {
      config: deps.config,
      db: deps.db,
      logger: deps.logger,
      session: deps.session,
      workspaces: deps.workspaces,
      sessions: deps.sessions,
      messages: deps.messages,
      runs: deps.runs
    };
    this.builder = new RunRuntimeBuilder({
      db: deps.db,
      logger: deps.logger,
      skills: deps.skills,
      agents: deps.agents,
      mcp: deps.mcp,
      planWeave: deps.planWeave,
      baseObserver: deps.baseObserver,
      plans: deps.plans
    });
  }

  /**
   * 跑一次 Run。**不抛** —— 失败的台账已经在里面收好,返回值只告诉 route 还能不能回状态码。
   *
   * `body` 是没校验过的原始请求体,schema 在这里 parse 而不是在 route:run 在看 body
   * **之前**就已经 register 进注册表了,所以校验失败也必须走同一套 finally 清理。
   * 把 parse 提到 route 会留下一个没人 unregister 的 runId。
   */
  async run(body: unknown, stream: RunEventStream, log: RunRequestLog): Promise<RunOutcome> {
    const runId = randomUUID();
    const controller = this.deps.runRegistry.register(runId);
    // register 时就建好了枢纽 —— 传进来这条连接只是它的第一个订阅者。
    const scope = new RunScope(runId, controller, this.deps.runRegistry.hubFor(runId)!);
    // 终态的唯一出口。建在 try 外:阶段①就抛错时也要有人收台账。
    const finalizer = this.deps.createFinalizer({
      runId,
      hub: scope.hub,
      failureLayer: scope.failureLayer
    });

    try {
      await this.execute(body, scope, stream, log, finalizer);
      return { kind: "streamed" };
    } catch (error) {
      // 409 是正常拒绝(会话忙),不该在日志里冒充故障。
      if (error instanceof SessionBusyError) {
        log.warn({ runId, activeRunId: error.activeRunId }, "session busy; run rejected");
      } else {
        log.error({ err: error, runId }, "failed to stream agent run");
      }

      finalizer.fail(error, {
        sessionId: scope.sessionId,
        createdSessionId: scope.input?.createdSessionId,
        phase: scope.phase
      });

      // 头还没发 → 交回 route 映射状态码。已经发了 → 只能从 SSE 通道告知。
      if (!scope.streamOpened) {
        return { kind: "rejected", error };
      }

      finalizer.closeWithError(error);
      return { kind: "streamed" };
    } finally {
      finalizer.release(scope.reportGateway);
    }
  }

  /** 五个阶段的正序。抛出的错误由 run() 统一收尾 —— 这里一个 catch 都没有,是故意的。 */
  private async execute(
    body: unknown,
    scope: RunScope,
    stream: RunEventStream,
    log: RunRequestLog,
    finalizer: ReturnType<RunFinalizerFactory>
  ): Promise<void> {
    const { runId, hub, emit } = scope;
    const runRequest = runRequestSchema.parse(body ?? {});

    // ── 阶段①:会话/工作区先落 —— agent 的工具集依赖工作区,工作区来自会话。
    const input = await prepareRunInput(this.preparation, runRequest, runId);
    scope.input = input;
    scope.sessionId = input.sessionId;
    const sessionId = input.sessionId;

    // 审批闸门:四级放行链、子代理自动通过、plan review 平行通道都在里面。
    // 建在阶段①之后 —— 它要 sessionId(policy key 与台账归属都按会话算)。
    const approvals = new RunApprovalChannel({
      approvals: this.deps.approvals,
      approvalPolicies: this.deps.approvalPolicies,
      runId,
      sessionId,
      emit
    });

    // T48:Run 提前到模型解析前创建 —— provider/模型/skill 解析失败也要有台账行
    // (failure_layer=routing);模型成功后 patchRouting 补实际模型。
    const observabilitySettings =
      loadAppSettings(this.deps.db, this.deps.config).observability;
    this.deps.runLedger.start({
      id: runId,
      sessionId,
      userMessageId: input.userMessageId,
      requestedModel: input.modelId,
      captureLevel: observabilitySettings.captureContent
    });
    scope.phase = "routing";

    // 本轮的事实打成一包交给 builder —— 它只接线,不决定顺序。
    const runtimeScope: RunRuntimeScope = {
      runId,
      sessionId,
      input,
      approvals,
      captureLevel: observabilitySettings.captureContent,
      observabilityEnabled: observabilitySettings.enabled,
      abortSignal: scope.controller.signal,
      emit
    };
    const observability = this.builder.createObservability(runtimeScope, {
      onFailureLayer: (layer) => {
        scope.failureLayer.current = layer;
      }
    });
    const { recorder } = observability;

    recorder.record({
      agent: "main",
      kind: "run_started",
      payload: {
        requestedModel: input.modelId,
        ...(input.workspace !== undefined ? { workspaceId: input.workspace.id } : {})
      }
    });

    // 会话一确定就先绑上:DB 里已经有 running 行,前端可能在 messageRecorder
    // 建好之前就来 attach —— 那时 run_start 不能给空 sessionId。
    hub.bind({ sessionId, snapshot: () => undefined });

    // ── 阶段②:这轮 agent 能用什么 —— skill / 记忆 / plan gate / MCP / plan weave / 模型。
    const { resolved, skillSelection } = await this.builder.buildAgent(
      runtimeScope,
      observability
    );

    // T48:路由结果回填 —— 从这一刻起 requested/resolved 都有值。
    this.deps.runLedger.patchRouting(
      runId,
      input.modelId,
      resolved.mainModel.qualifiedModelId
    );
    recorder.record({
      agent: "main",
      kind: "routing_resolved",
      payload: {
        requestedModel: input.modelId,
        resolvedModel: resolved.mainModel.qualifiedModelId
      }
    });
    scope.phase = "context";

    // ── 阶段③:模型这轮看见什么(需要 mainModel 的窗口信息)。
    const runContext = await prepareRunContext(this.preparation, input, resolved);

    // 进入流式:之后的失败由 T49 的事件层归因,catch 不再盖 routing/context 的章。
    scope.phase = undefined;

    // ── 阶段④:开流。
    stream.open();
    scope.streamOpened = true;
    // 自己这条连接就是源头,不需要重放;run_start 仍旧显式发一次。
    void hub.attach(stream, { replay: false });
    emit({ type: "run_start", runId, sessionId });

    // 子代理运行时必须在 stream.open() 之后 —— 子代理的 SSE 帧要有连接可推。
    const subagents = this.builder.buildSubagents(runtimeScope, resolved, observability.bridge);
    scope.reportGateway = subagents.reportGateway;

    // 断连只是少了一个观众:run 继续跑,pending 审批继续等人。
    // 想真的停下来只有一条路:POST /runs/:runId/abort。
    stream.onDisconnect(() => {
      hub.detach(stream);
      log.info({ runId }, "sse subscriber left; run continues detached");
    });

    const messageRecorder = new AssistantMessageRecorder(this.deps.session, {
      sessionId,
      runId,
      model: resolved.mainModel.qualifiedModelId,
      initialPosition: input.assistantPosition,
      lookupDecision: approvals.lookupApprovalDecision,
      lookupPlanReviewDecision: approvals.lookupPlanReviewDecision
    });

    // 补上快照来源(sessionId 在阶段①就绑过了)。recorder 在 notice-injected 边界会
    // 被换掉,所以每次都读当前那个 —— 已落库的前几条由 GET /threads/:id/messages 带回。
    hub.bind({ sessionId, snapshot: () => messageRecorder.snapshot() });

    // ── 阶段⑤:流式循环。13 行 —— 它不配一个文件(§7.2)。
    for await (const event of resolved.agent.stream({
      messages: runContext.modelMessages,
      abortSignal: scope.controller.signal,
      drainNotices: (opts) => subagents.reportGateway.drain(opts),
      additionalTools: [...runContext.additionalTools, ...subagents.tools],
      // T44:skill allowed-tools 只作 preferred —— <=40 全集本来就可用,>40 并入首步 active。
      preferredToolNames: skillSelection.preferredToolNames,
      ...(runContext.context !== undefined ? { context: runContext.context } : {})
    })) {
      emit(event);
      messageRecorder.push(event);
    }

    finalizer.settle(messageRecorder);
  }
}
