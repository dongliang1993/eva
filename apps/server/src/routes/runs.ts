import { randomUUID } from "node:crypto";

import {
  classifyToolRisk,
  createSubagentTool,
  type RequestApproval
} from "@eva/harness";
import type { FastifyInstance } from "fastify";
import type { RunStreamEvent } from "@eva/shared";
import { toErrorMessage } from "@eva/shared";

import { AgentUnavailableError } from "../agent.js";
import { loadAppSettings } from "../services/settings/app-settings.js";
import { evaDataDir } from "../paths.js";
import { loadMemoryFilesSection, todayString } from "../services/memory/index.js";
import { AssistantMessageRecorder } from "../services/runs/assistant-message-recorder.js";
import {
  openSessionTurn,
  prepareRunContext,
  type OpenTurn,
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
    const stream = new RunEventStream(reply);
    let sessionId = "";
    // 供 catch 回滚 503 时新建的会话。
    let open: OpenTurn | undefined;
    // 回报网关与 run 同寿:主 loop 收尾前 drain 一次,把后台子代理刚交付的结论
    // 注入本轮对话(S7 push)。声明在 try 外,finally 才能 dispose。
    let reportGateway: ReportGateway | undefined;

    const emit = (event: RunStreamEvent): void => stream.emit(event);
    const preparationDependencies: RunPreparationDependencies = {
      config: app.infra.config,
      db: app.infra.db,
      logger: app.log,
      session: app.services.session,
      workspaces: app.services.workspaces
    };

    const requestApproval: RequestApproval = async ({ toolCallId, toolName, args }) => {
      const settings = loadAppSettings(app.infra.db, app.infra.config);

      // T14:per-tool 白名单取代全局开关。命中才直接放行,否则走审批卡片。
      // (MCP 侧 per-server 白名单先于这里判,见 services/mcp/mcp-tools.ts)
      if (settings.security.alwaysAllowTools.includes(toolName)) {
        return true;
      }

      const risk = classifyToolRisk(toolName, args);
      emit({ type: "approval_request", callId: toolCallId, toolName, args, risk });
      const approved = await app.services.approvals.ask(toolCallId, {
        runId,
        sessionId,
        tool: toolName,
        args
      });
      emit({ type: "approval_resolved", callId: toolCallId, approved });

      return approved;
    };

    try {
      const body = runRequestSchema.parse(request.body ?? {});

      // 阶段①:会话/工作区先落 —— agent 的工具集依赖工作区,工作区来自会话。
      open = await openSessionTurn(preparationDependencies, body, runId);
      sessionId = open.sessionId;

      // MCP 连接在这里懒触发(首个 run 付一次成本,之后是空调用)。连不上的 server
      // 只在 registry 里记 error,工具缺席即可 —— MCP 不可用绝不让对话失败。
      await app.services.mcp.ensureConnected();

      // 阶段②:解析模型(带工作区 + MCP 工具)。模型不可用(503)时,本次刚建的会话要回滚。
      // memory files 与工作区无关(~/.eva 是全局的),per-run 读 —— 没绑工作区的会话也注入。
      const memoryFilesSection = await loadMemoryFilesSection(evaDataDir(), todayString());

      // 模型在阶段①就定好了(send = body.modelId,retry = body 或会话记录),
      // 这里直接用 —— 没有兜底链,拿不到模型在 openSessionTurn 里就已经报错。
      const resolved = app.services.agents.resolve({
        requestedModelId: open.modelId,
        ...(open.workspace !== undefined ? { workspace: open.workspace } : {}),
        extraTools: app.services.mcp.listTools(),
        requestApproval,
        ...(memoryFilesSection !== undefined ? { memoryFilesSection } : {})
      });

      // 阶段③:模型这轮看见什么(需要 mainModel 的窗口信息)。
      const prepared = await prepareRunContext(preparationDependencies, open, resolved);

      app.services.runLedger.start({
        id: runId,
        sessionId,
        model: resolved.mainModel.qualifiedModelId,
        userMessageId: prepared.userMessageId
      });

      stream.open();
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
          ...(open.workspace !== undefined ? { workspace: open.workspace } : {}),
          extraTools: app.services.mcp.listTools(),
          abortSignal: controller.signal,
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

      stream.onDisconnect(() => {
        app.services.runRegistry.abort(runId);
        // 别让 pending 审批吊住 agent loop —— 归属键是 runId,不需要先知道会话
        app.services.approvals.cancelByRun(runId);
      });

      const messageRecorder = new AssistantMessageRecorder(app.services.session, {
        sessionId,
        runId,
        model: resolved.mainModel.qualifiedModelId,
        initialPosition: open.assistantPosition
      });

      for await (const event of resolved.agent.stream({
        messages: prepared.modelMessages,
        abortSignal: controller.signal,
        drainNotices: (opts) => reportGateway!.drain(opts),
        ...(prepared.additionalTools.length > 0
          ? { additionalTools: [...prepared.additionalTools, ...subagentTools] }
          : { additionalTools: [...subagentTools] }),
        ...(prepared.context !== undefined ? { context: prepared.context } : {})
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
      stream.close();
    } catch (error) {
      request.log.error({ err: error, runId }, "failed to stream agent run");

      // 模型不可用(503)且这条会话是本次请求刚建的 → 撤掉,别让没配好 API key 的
      // 新装用户每点一次发送就攒一条空会话。已有会话不动:用户说的话得留下。
      if (error instanceof AgentUnavailableError && open?.createdSessionId) {
        app.services.session.deleteSession(open.createdSessionId);
      }

      if (sessionId) {
        app.services.runLedger.fail(runId, toErrorMessage(error));
      }

      if (!reply.raw.headersSent) {
        reply.code(error instanceof AgentUnavailableError ? 503 : 400);

        return { error: toErrorMessage(error) };
      }

      emit({ type: "error", message: toErrorMessage(error) });
      emit({ type: "end", finishReason: "error" });
      stream.close();
    } finally {
      // 唤醒可能还在等通知的 drain,别留悬挂 Promise。
      reportGateway?.dispose();
      app.services.runRegistry.unregister(runId);
      // pending 审批要么已被决策、要么被上面 cancelByRun 清掉;这里兜底。
      app.services.approvals.cancelByRun(runId);
    }
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
