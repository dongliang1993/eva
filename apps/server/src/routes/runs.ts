import { randomUUID } from "node:crypto";

import {
  createPlanGateState,
  createPlanWeaveTools,
  createSubagentTool,
  type PlanGateState,
  type RequestPlanReview
} from "@eva/harness";
import type { FastifyInstance } from "fastify";
import type { RunStreamEvent } from "@eva/shared";
import { toErrorMessage } from "@eva/shared";

import { AgentUnavailableError, defined } from "../services/agent-factory.js";
import { DrizzlePlanRepository } from "../db/repositories/plan-repository.js";
import { createPlanGateStore, planGateRelPath } from "../services/plan-gate/index.js";
import { createPlanWeaveGateway } from "../services/plan-weave/index.js";
import { evaDataDir } from "../paths.js";
import { loadMemoryFilesSection, todayString } from "../services/memory/index.js";
import { AssistantMessageRecorder } from "../services/runs/assistant-message-recorder.js";
import { RunApprovalChannel } from "../services/runs/run-approval-channel.js";
import {
  prepareRunInput,
  prepareRunContext,
  SessionBusyError,
  type RunInput,
  type RunPreparationDependencies
} from "../services/runs/run-preparation.js";
import { selectRunSkills } from "../services/skills/select-run-skills.js";
import { SubagentRunner } from "../services/subagents/subagent-runner.js";
import { ReportGateway } from "../services/subagents/report-gateway.js";
import { loadAppSettings } from "../services/settings/app-settings.js";
import { createObserverBridge, fanout } from "../services/observability/observer-bridge.js";
import { createRunRecorder } from "../services/observability/run-recorder.js";
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
    let runPhase: "routing" | "context" | undefined;
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
      const observability = loadAppSettings(app.infra.db, app.infra.config).observability;
      app.services.runLedger.start({
        id: runId,
        sessionId,
        userMessageId: runInput.userMessageId,
        requestedModel: runInput.modelId,
        captureLevel: observability.captureContent
      });
      // 失败归因的阶段标记:流式开始前的失败才算 routing/context;stream 内失败
      // 的细粒度归因走 T49 的事件层,不在 catch 里猜。
      runPhase = "routing";

      // T49:run-scoped recorder + observer 桥。runId 在 recorder、agent 在绑定,
      // 没有隐式 current run(契约 3)。主 Agent 与前台子代理共用这个 recorder
      // (UNIQUE(run_id, seq) 成立的理由);后台子代理另建自己 Run 的 recorder。
      const recorder = createRunRecorder(
        {
          db: app.infra.db,
          logger: app.log,
          enabled: observability.enabled,
          captureLevel: observability.captureContent
        },
        { runId, sessionId }
      );
      const observerBridge = createObserverBridge(recorder, {
        onFailureLayer: (layer) => {
          failureLayerRef.current = layer;
        }
      });
      // Pino 是第二订阅者:ledger 写挂了 Pino 照常,反之亦然。
      const observer = fanout(observerBridge.forAgent("main"), app.infra.observer);

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

      // MCP 连接在这里懒触发(首个 run 付一次成本,之后是空调用)。连不上的 server
      // 只在 registry 里记 error,工具缺席即可 —— MCP 不可用绝不让对话失败。
      await app.services.mcp.ensureConnected();

      // 模型在阶段①就定好了(send = body.modelId,retry = body 或会话记录),
      // 这里直接用 —— 没有兜底链,拿不到模型在 prepareRunInput 里就已经报错。
      //
      // memoryFilesSection 不依赖模型也不依赖工作区(~/.eva 全局),但它要喂给
      // resolve(agent 的 prompt section),而 prepareRunContext 又吃 resolved.mainModel
      // 的窗口信息 —— 所以 section 在 resolve 之前备好,别和模型相关准备混在一起。
      const memoryFilesSection = await loadMemoryFilesSection(evaDataDir(), todayString());

      // T44:skill auto-selection 在装 agent 前完成 —— 它决定 prompt 列哪些
      // metadata,也决定本轮显式 activeToolNames(always ∪ thread 累积 ∪ 新选)。
      const skillSelection = await selectRunSkills({
        db: app.infra.db,
        skills: app.infra.skills,
        agents: app.services.agents,
        sessionId,
        modelId: runInput.modelId,
        humanText: runInput.humanText
      });
      recorder.record({
        agent: "main",
        kind: "skills_selected",
        payload: {
          selected: skillSelection.selectedSkills.map((skill) => skill.name),
          usedFallback: skillSelection.usedFallback
        }
      });

      // T45a:绑了 workspace 才装 plan gate。state 初值来自 DB 里该 session 的 active plan,
      // 之后由 enter/exit 工具在同一份引用上改 —— 不是 build 期快照。
      let planGate:
        | {
            state: PlanGateState;
            store: ReturnType<typeof createPlanGateStore>;
            requestPlanReview: RequestPlanReview;
          }
        | undefined;
      if (runInput.workspace) {
        const activePlan = new DrizzlePlanRepository(app.infra.db).findActive(sessionId);
        const planGateState = createPlanGateState(
          activePlan
            ? {
                active: true,
                planId: activePlan.id,
                planPath: activePlan.path,
                planRelPath: planGateRelPath(activePlan.id)
              }
            : { active: false }
        );
        // 同一个引用交给两边:agent 的 enter/exit 工具在上面改,审批通道读它判「plan 文件写直放」。
        approvalChannel.bindPlanGate(planGateState);
        planGate = {
          state: planGateState,
          store: createPlanGateStore({
            db: app.infra.db,
            sessionId,
            workspace: runInput.workspace
          }),
          requestPlanReview: approvalChannel.requestPlanReview
        };
      }

      const resolved = app.services.agents.build({
        modelId: runInput.modelId,
        observer,
        extraTools: [
          ...app.services.mcp.listTools(),
          // T46:plan weave 工具与 fs 工具同一个注入条件 —— 无 workspace 则无 plan_*。
          // gateway 把 workspaceId/runId 绑死在 server 侧,工具入参不带任何路径(契约 8)。
          ...(runInput.workspace
            ? createPlanWeaveTools(
                createPlanWeaveGateway(
                  app.services.planWeave,
                  runInput.workspace.id,
                  runId
                )
              )
            : [])
        ],
        requestApproval: approvalChannel.requestApproval,
        selectedSkills: skillSelection.selectedSkills,
        ...defined("workspace", runInput.workspace),
        ...defined("planGate", planGate),
        ...defined("memoryFilesSection", memoryFilesSection)
      });
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

      // 阶段④:S7 子代理运行时 —— subagent 基元注入主 agent,回报走 push(无 join 工具)。
      // sink 做两件事:① emit 推 SSE(前端子代理卡片拿流式过程);② recorder 攒
      // 事件,子代理 finish 时落库(parentToolCallId 隔离卖力,见 subagent-recorder)。
      // abortSignal 传给后台子代理:T15 §2.7 —— 用户点停止,子代理一起停,不留孤儿。
      const subagentRunner = new SubagentRunner(
        app.services.agents,
        {
          sessionId,
          db: app.infra.db,
          runId,
          model: resolved.mainModel.qualifiedModelId,
          captureLevel: observability.captureContent,
          observer: app.infra.observer,
          // T49:前台子代理绑父 Run 的 bridge(agent=taskId,seq 与主 Agent 同序列);
          // 后台子代理有自己 Run 的 recorder(T48 §2.3),seq 从 0 重新计。
          observerForTask: (taskId) =>
            fanout(observerBridge.forAgent(taskId), app.infra.observer),
          createChildObserver: (childRunId, taskId) =>
            fanout(
              createObserverBridge(
                createRunRecorder(
                  {
                    db: app.infra.db,
                    logger: app.log,
                    enabled: observability.enabled,
                    captureLevel: observability.captureContent
                  },
                  { runId: childRunId, sessionId }
                )
              ).forAgent(taskId),
              app.infra.observer
            ),
          ...(runInput.workspace !== undefined ? { workspace: runInput.workspace } : {}),
          extraTools: app.services.mcp.listTools(),
          abortSignal: controller.signal,
          requestApproval: approvalChannel.subagentRequestApproval,
          onSubagentEvent: (event) => {
            emit({ type: "subagent_update", ...event });
          },
          onNotice: (notice) => {
            reportGateway?.push(notice);
            // 卡片要能即时显示"已回报",不必等主 loop 注入。
            if (notice.kind === "reported") {
              emit({
                type: "subagent_report",
                taskId: notice.taskId,
                parentToolCallId: notice.parentToolCallId,
                description: notice.description,
                output: notice.output ?? ""
              });
            }
          }
        }
      );

      reportGateway = new ReportGateway(() => subagentRunner.hasLiveTasks());
      const subagentTools = createSubagentTool({
        runFork: subagentRunner.runFork
      });

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
        drainNotices: (opts) => reportGateway!.drain(opts),
        additionalTools: [...runContext.additionalTools, ...subagentTools],
        // T44:skill allowed-tools 只作 preferred —— <=40 全集本来就可用,>40 并入首步 active。
        preferredToolNames: skillSelection.preferredToolNames,
        ...(runContext.context !== undefined ? { context: runContext.context } : {})
      })) {
        emit(event);
        messageRecorder.push(event);
      }

      // assistantMessage 无论什么终态都落库(含 aborted / error)。丢一半的回复也比
      // DB 里没痕迹强 —— metadata.aborted 标出来即可。
      const recorded = messageRecorder.finish();

      app.services.runLedger.settle(runId, {
        finishReason: recorded.finishReason,
        assistantMessageId: recorded.assistantMessageId,
        ...(recorded.usage !== undefined ? { usage: recorded.usage } : {}),
        ...(recorded.streamError !== undefined ? { error: recorded.streamError } : {}),
        ...(failureLayerRef.current !== undefined
          ? { failureLayer: failureLayerRef.current }
          : {})
      });

      emit({ type: "end", finishReason: recorded.finishReason });
      hub.closeAll();
    } catch (error) {
      // 409 是正常拒绝(会话忙),不该在日志里冒充故障。
      if (error instanceof SessionBusyError) {
        request.log.warn({ runId, activeRunId: error.activeRunId }, "session busy; run rejected");
      } else {
        request.log.error({ err: error, runId }, "failed to stream agent run");
      }

      // 模型不可用(503)且这条会话是本次请求刚建的 → 撤掉,别让没配好 API key 的
      // 新装用户每点一次发送就攒一条空会话。已有会话不动:用户说的话得留下。
      if (error instanceof AgentUnavailableError && runInput?.createdSessionId) {
        app.services.session.deleteSession(runInput.createdSessionId);
      }

      if (sessionId) {
        app.services.runLedger.fail(
          runId,
          toErrorMessage(error),
          runPhase !== undefined
            ? { failureLayer: runPhase }
            : failureLayerRef.current !== undefined
              ? { failureLayer: failureLayerRef.current }
              : {}
        );
      }

      if (!reply.raw.headersSent) {
        // 409 带上 activeRunId:前端据此直接挂到在跑的那个 run 上,不用再查一次 status。
        if (error instanceof SessionBusyError) {
          reply.code(409);

          return { error: toErrorMessage(error), activeRunId: error.activeRunId };
        }

        reply.code(error instanceof AgentUnavailableError ? 503 : 400);

        return { error: toErrorMessage(error) };
      }

      emit({ type: "error", message: toErrorMessage(error) });
      emit({ type: "end", finishReason: "error" });
      hub.closeAll();
    } finally {
      // 唤醒可能还在等通知的 drain,别留悬挂 Promise。
      reportGateway?.dispose();
      app.services.runRegistry.unregister(runId);
      // pending 审批要么已被决策、要么被上面 cancelByRun 清掉;这里兜底。
      app.services.approvals.cancelByRun(runId);
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
