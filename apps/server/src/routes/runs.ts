import { randomUUID } from "node:crypto";

import {
  classifyToolRisk,
  createSubagentTool,
  isSafeReadOnlyCommand,
  type RequestApproval
} from "@eva/harness";
import type { FastifyInstance } from "fastify";
import type { ApprovalDecision, RunStreamEvent } from "@eva/shared";
import { toErrorMessage } from "@eva/shared";

import { AgentUnavailableError, defined } from "../services/agent-factory.js";
import { evaDataDir } from "../paths.js";
import { loadMemoryFilesSection, todayString } from "../services/memory/index.js";
import { AssistantMessageRecorder } from "../services/runs/assistant-message-recorder.js";
import {
  prepareRunInput,
  prepareRunContext,
  SessionBusyError,
  type RunInput,
  type RunPreparationDependencies
} from "../services/runs/run-preparation.js";
import { SubagentRunner } from "../services/subagents/subagent-runner.js";
import { ReportGateway } from "../services/subagents/report-gateway.js";
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

    // T30:审批决策的唯一查询口 —— finish 落库回写与 approval_resolved 帧共用。
    // 事实源是 approval_requests 行,不是 SSE 事件(§坑 3:回放路径不带 decision)。
    const lookupApprovalDecision = (callId: string): ApprovalDecision | undefined => {
      const row = app.services.approvals.getRequest(callId);
      if (!row || row.status === "pending" || !row.decidedAt) return undefined;
      return { action: row.status, decidedAt: row.decidedAt };
    };

    const requestApproval: RequestApproval = async ({ toolCallId, toolName, args }) => {
      // T29:bash 只读命令直放落台账。harness 的 withApproval 已短路(requestApproval
      // 根本不被调),所以「没弹窗但执行了」要在这里补一笔 —— 与 harness 共用同一个
      // isSafeReadOnlyCommand,判定不漂移(r7 §3 契约 2)。
      if (
        toolName === "bash" &&
        isSafeReadOnlyCommand(String((args as Record<string, unknown>)?.command ?? ""))
      ) {
        app.services.approvals.autoApprove(
          toolCallId,
          { runId, sessionId, tool: toolName, args },
          "readonly-safe"
        );
        return true;
      }

      const risk = classifyToolRisk(toolName, args);

      // T28:policy 记忆短路(Alma 放行链第 2 级)。必须在 emit approval_request 之前 ——
      // 放进 ask 内部会让「没问过人」的卡片在前端闪一帧。命中 = 台账 granted + 直放。
      const policyHit = app.services.approvalPolicies.match(toolName, sessionId, args);
      if (policyHit) {
        app.services.approvals.autoApprove(
          toolCallId,
          { runId, sessionId, tool: toolName, args },
          `policy:${policyHit}`
        );
        return true;
      }

      emit({ type: "approval_request", callId: toolCallId, toolName, args, risk });
      const approved = await app.services.approvals.ask(toolCallId, {
        runId,
        sessionId,
        tool: toolName,
        args
      });
      // T30:ask 返回时行已 decided —— 从台账查回 decision 附进帧,前端定格态用。
      emit({
        type: "approval_resolved",
        callId: toolCallId,
        approved,
        decision: lookupApprovalDecision(toolCallId) ?? {
          action: approved ? "granted" : "denied",
          decidedAt: new Date().toISOString()
        }
      });

      return approved;
    };

    // 子代理分支(T17,docs 04 §8.6.1):后台子代理没人能点弹窗 —— 进闸门、
    // 自动通过、落台账。不发 approval_request:后台的 SSE 帧混进主流会让前端
    // 冒出 runId 相同但 toolCallId 陌生的审批卡片。
    const subagentRequestApproval: RequestApproval = async ({ toolCallId, toolName, args }) =>
      app.services.approvals.autoApprove(toolCallId, {
        runId,
        sessionId,
        tool: toolName,
        args
      });

    try {
      const body = runRequestSchema.parse(request.body ?? {});

      // 阶段①:会话/工作区先落 —— agent 的工具集依赖工作区,工作区来自会话。
      runInput = await prepareRunInput(preparationDependencies, body, runId);
      sessionId = runInput.sessionId;
      // 会话一确定就先绑上:runLedger.start 之后 DB 里已经有 running 行,前端
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

      const resolved = app.services.agents.build({
        modelId: runInput.modelId,
        extraTools: app.services.mcp.listTools(),
        requestApproval,
        ...defined("workspace", runInput.workspace),
        ...defined("memoryFilesSection", memoryFilesSection)
      });

      // 阶段③:模型这轮看见什么(需要 mainModel 的窗口信息)。
      const runContext = await prepareRunContext(preparationDependencies, runInput, resolved);

      app.services.runLedger.start({
        id: runId,
        sessionId,
        model: resolved.mainModel.qualifiedModelId,
        userMessageId: runContext.userMessageId
      });

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
          ...(runInput.workspace !== undefined ? { workspace: runInput.workspace } : {}),
          extraTools: app.services.mcp.listTools(),
          abortSignal: controller.signal,
          requestApproval: subagentRequestApproval,
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
        lookupDecision: lookupApprovalDecision
      });

      // 补上快照来源(sessionId 在阶段①就绑过了)。builder 在 notice-injected 边界会
      // 被换掉,所以每次都读当前那个 —— 已落库的前几条由 GET /threads/:id/messages 带回。
      hub.bind({ sessionId, snapshot: () => messageRecorder.snapshot() });

      for await (const event of resolved.agent.stream({
        messages: runContext.modelMessages,
        abortSignal: controller.signal,
        drainNotices: (opts) => reportGateway!.drain(opts),
        additionalTools: [...runContext.additionalTools, ...subagentTools],
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
        ...(recorded.streamError !== undefined ? { error: recorded.streamError } : {})
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
        app.services.runLedger.fail(runId, toErrorMessage(error));
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
