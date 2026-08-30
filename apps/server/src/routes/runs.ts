import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { RunStreamEvent } from "@eva/shared";
import { toErrorMessage } from "@eva/shared";

import { AgentUnavailableError } from "../services/agent-factory.js";
import { AssistantMessageRecorder } from "../services/runs/assistant-message-recorder.js";
import { RunApprovalChannel } from "../services/runs/run-approval-channel.js";
import {
  RunFinalizer,
  type RunFailurePhase
} from "../services/runs/run-finalizer.js";
import {
  prepareRunInput,
  prepareRunContext,
  SessionBusyError,
  type RunInput,
  type RunPreparationDependencies
} from "../services/runs/run-preparation.js";
import {
  RunRuntimeBuilder,
  type RunRuntimeScope
} from "../services/runs/run-runtime-builder.js";
import type { ReportGateway } from "../services/subagents/report-gateway.js";
import { loadAppSettings } from "../services/settings/app-settings.js";
import type { RunFailureLayer } from "../db/schema.js";
import { runRequestSchema } from "../types/runs.js";
import { RunEventStream } from "../transports/sse/event-stream.js";

export const registerRunRoutes = (app: FastifyInstance): void => {
  app.post("/api/v1/runs/stream", async (request, reply) => {
    const runId = randomUUID();
    const controller = app.services.runRegistry.register(runId);
    // register 时就建好了枢纽 —— 这条连接只是它的第一个订阅者。
    const hub = app.services.runRegistry.hubFor(runId)!;
    const stream = new RunEventStream(reply);
    let sessionId = "";
    // 供 catch 回滚 503 时新建的会话。
    let runInput: RunInput | undefined;
    // T48 失败归因:流式开始前失败的层。"routing" = provider/模型/skill 解析;
    // "context" = prepareRunContext(compact/历史转换);undefined = 已进入流式(归因走事件层)。
    let runPhase: RunFailurePhase | undefined;
    // T49:run_failed / max-steps 事件带的失败层(agent.ts 发出,observer 桥回填),
    // settle/fail 时写进 runs。声明在 try 外,catch 才能读到。
    const failureLayerRef: { current?: RunFailureLayer } = {};
    // 回报网关与 run 同寿:主 loop 收尾前 drain 一次,把后台子代理刚交付的结论
    // 注入本轮对话(S7 push)。声明在 try 外,finally 才能 dispose。
    let reportGateway: ReportGateway | undefined;

    // 扇出而不是直写:重连上来的订阅者也要收到后续的帧。
    const emit = (event: RunStreamEvent): void => hub.publish(event);
    const preparationDependencies: RunPreparationDependencies = {
      config: app.infra.config,
      db: app.infra.db,
      logger: app.log,
      session: app.services.session,
      workspaces: app.services.workspaces
    };
    // 终态的唯一出口。建在 try 外:阶段①就抛错时也要有人收台账。
    const finalizer = new RunFinalizer({
      runId,
      runLedger: app.services.runLedger,
      session: app.services.session,
      runRegistry: app.services.runRegistry,
      approvals: app.services.approvals,
      hub,
      failureLayer: failureLayerRef
    });
    const builder = new RunRuntimeBuilder({
      db: app.infra.db,
      logger: app.log,
      skills: app.infra.skills,
      agents: app.services.agents,
      mcp: app.services.mcp,
      planWeave: app.services.planWeave,
      baseObserver: app.infra.observer
    });

    try {
      const body = runRequestSchema.parse(request.body ?? {});

      // 阶段①:会话/工作区先落 —— agent 的工具集依赖工作区,工作区来自会话。
      runInput = await prepareRunInput(preparationDependencies, body, runId);
      sessionId = runInput.sessionId;

      // 审批闸门:四级放行链、子代理自动通过、plan review 平行通道都在里面。
      // 建在阶段①之后 —— 它要 sessionId(policy key 与台账归属都按会话算)。
      const approvalChannel = new RunApprovalChannel({
        approvals: app.services.approvals,
        approvalPolicies: app.services.approvalPolicies,
        runId,
        sessionId,
        emit
      });

      // T48:Run 提前到模型解析前创建 —— provider/模型/skill 解析失败也要有台账行
      // (failure_layer=routing);模型成功后 patchRouting 补实际模型。
      const observabilitySettings =
        loadAppSettings(app.infra.db, app.infra.config).observability;
      app.services.runLedger.start({
        id: runId,
        sessionId,
        userMessageId: runInput.userMessageId,
        requestedModel: runInput.modelId,
        captureLevel: observabilitySettings.captureContent
      });
      // 失败归因的阶段标记:流式开始前的失败才算 routing/context;stream 内失败
      // 的细粒度归因走 T49 的事件层,不在 catch 里猜。
      runPhase = "routing";

      // 本轮的事实打成一包交给 builder —— 它只接线,不决定顺序。
      const runtimeScope: RunRuntimeScope = {
        runId,
        sessionId,
        input: runInput,
        approvals: approvalChannel,
        captureLevel: observabilitySettings.captureContent,
        observabilityEnabled: observabilitySettings.enabled,
        abortSignal: controller.signal,
        emit
      };
      const observability = builder.createObservability(runtimeScope, {
        onFailureLayer: (layer) => {
          failureLayerRef.current = layer;
        }
      });
      const { recorder } = observability;

      recorder.record({
        agent: "main",
        kind: "run_started",
        payload: {
          requestedModel: runInput.modelId,
          ...(runInput.workspace !== undefined
            ? { workspaceId: runInput.workspace.id }
            : {})
        }
      });

      // 会话一确定就先绑上:DB 里已经有 running 行,前端
      // 可能在 messageRecorder 建好之前就来 attach —— 那时 run_start 不能给空 sessionId。
      hub.bind({ sessionId, snapshot: () => undefined });

      // 阶段②:这轮 agent 能用什么 —— skill / 记忆 / plan gate / MCP / plan weave / 模型。
      const { resolved, skillSelection } = await builder.buildAgent(runtimeScope, observability);

      // T48:路由结果回填 —— 从这一刻起 requested/resolved 都有值。
      app.services.runLedger.patchRouting(
        runId,
        runInput.modelId,
        resolved.mainModel.qualifiedModelId
      );
      recorder.record({
        agent: "main",
        kind: "routing_resolved",
        payload: {
          requestedModel: runInput.modelId,
          resolvedModel: resolved.mainModel.qualifiedModelId
        }
      });
      runPhase = "context";

      // 阶段③:模型这轮看见什么(需要 mainModel 的窗口信息)。
      const runContext = await prepareRunContext(preparationDependencies, runInput, resolved);

      // 进入流式:之后的失败由 T49 的事件层归因,catch 不再盖 routing/context 的章。
      runPhase = undefined;

      stream.open();
      // 自己这条连接就是源头,不需要重放;run_start 仍旧显式发一次。
      void hub.attach(stream, { replay: false });
      emit({ type: "run_start", runId, sessionId });

      // 阶段④:子代理运行时。必须在 stream.open() 之后 —— 子代理的 SSE 帧要有连接可推。
      const subagents = builder.buildSubagents(runtimeScope, resolved, observability.bridge);
      reportGateway = subagents.reportGateway;

      // 断连只是少了一个观众:run 继续跑,pending 审批继续等人。
      // 想真的停下来只有一条路:POST /runs/:runId/abort。
      stream.onDisconnect(() => {
        hub.detach(stream);
        request.log.info({ runId }, "sse subscriber left; run continues detached");
      });

      const messageRecorder = new AssistantMessageRecorder(app.services.session, {
        sessionId,
        runId,
        model: resolved.mainModel.qualifiedModelId,
        initialPosition: runInput.assistantPosition,
        lookupDecision: approvalChannel.lookupApprovalDecision,
        lookupPlanReviewDecision: approvalChannel.lookupPlanReviewDecision
      });

      // 补上快照来源(sessionId 在阶段①就绑过了)。builder 在 notice-injected 边界会
      // 被换掉,所以每次都读当前那个 —— 已落库的前几条由 GET /threads/:id/messages 带回。
      hub.bind({ sessionId, snapshot: () => messageRecorder.snapshot() });

      for await (const event of resolved.agent.stream({
        messages: runContext.modelMessages,
        abortSignal: controller.signal,
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
    } catch (error) {
      // 409 是正常拒绝(会话忙),不该在日志里冒充故障。
      if (error instanceof SessionBusyError) {
        request.log.warn({ runId, activeRunId: error.activeRunId }, "session busy; run rejected");
      } else {
        request.log.error({ err: error, runId }, "failed to stream agent run");
      }

      finalizer.fail(error, {
        sessionId,
        createdSessionId: runInput?.createdSessionId,
        phase: runPhase
      });

      if (!reply.raw.headersSent) {
        // 409 带上 activeRunId:前端据此直接挂到在跑的那个 run 上,不用再查一次 status。
        if (error instanceof SessionBusyError) {
          reply.code(409);

          return { error: toErrorMessage(error), activeRunId: error.activeRunId };
        }

        reply.code(error instanceof AgentUnavailableError ? 503 : 400);

        return { error: toErrorMessage(error) };
      }

      finalizer.closeWithError(error);
    } finally {
      finalizer.release(reportGateway);
    }
  });

  /**
   * 重新挂到一个在飞的 run 上 —— 刷新页面后续跟流。
   *
   * 与 POST 同形:handler 里 await 住(RunEventStream 不 hijack reply),
   * 订阅者退场或 run 收尾时 attach 的 promise 兑现,handler 才返回。
   */
  app.get("/api/v1/runs/:runId/stream", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const hub = app.services.runRegistry.hubFor(runId);

    // 404 是正常语义:run 在刷新与这次请求之间跑完了 —— 前端退回只读 DB 消息。
    if (!hub) {
      reply.code(404);
      return { error: "run not found or already finished" };
    }

    const stream = new RunEventStream(reply);
    stream.open();
    const done = hub.attach(stream, { replay: true });
    stream.onDisconnect(() => hub.detach(stream));

    await done;

    return undefined;
  });

  app.post("/api/v1/runs/:runId/abort", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    if (!app.services.runRegistry.abort(runId)) {
      reply.code(404);
      return { error: "run not found or already finished" };
    }

    // 中止时立刻拒绝该 run 下 pending 的审批,否则 agent loop 会被吊住
    app.services.approvals.cancelByRun(runId);

    return { ok: true };
  });
};
