import { randomUUID } from "node:crypto";

import { convertToModelMessages, type ModelMessage } from "ai";
import type { RequestApproval } from "@eva/harness";
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  RunStreamEvent,
  RunStreamFrame,
  StreamFinishReason,
  StreamTokenUsage
} from "@eva/shared";
import {
  UiMessageBuilder,
  createUserUIMessage,
  toErrorMessage
} from "@eva/shared";

import {
  AgentUnavailableError,
  type ResolvedWorkspaceContext
} from "../agent.js";
import { DrizzleRunRepository, runStatusFor } from "../db/repositories/run-repository.js";
import { DrizzleSessionRepository } from "../db/repositories/session-repository.js";
import { autoCompactIfNeeded, createAutoCompactConfig } from "../services/auto-compact.js";
import { buildMemoryRuntimeSupport } from "../services/memory-runtime.js";
import type { ModelBinding } from "../services/providers/model-resolver.js";
import { loadAppSettings } from "../services/settings/app-settings.js";
import { createModelSummarizer } from "../services/summarize-with-model.js";
import { estimateModelHistoryTokens } from "../services/token-estimator.js";
import { loadProjectDocsSection } from "../services/workspaces/project-docs.js";
import { resolveWorkspaceForSession } from "../services/workspaces/workspace-store.js";
import { runRequestSchema, type RunRequest } from "../types/runs.js";

const formatSseFrame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const writeFrame = (reply: FastifyReply, frame: RunStreamFrame): void => {
  reply.raw.write(formatSseFrame(frame.type, frame));
};

interface PreparedRun {
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly modelMessages: ModelMessage[];
  readonly additionalTools: readonly import("@eva/harness").AgentTool[];
  readonly context?: Record<string, unknown>;
}

interface OpenTurn {
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly workspace?: ResolvedWorkspaceContext | undefined;
  /** 本次请求新建了会话时非空 —— 供 503 回滚用。 */
  readonly createdSessionId?: string | undefined;
}

/**
 * 阶段①:建/取会话 + 落用户消息 + 解析工作区(含 project docs)。
 * 只回答「这次对话发生在哪」。不碰模型 —— 模型是阶段②(工作区确定后)才知道的。
 */
const openSessionTurn = async (
  app: FastifyInstance,
  body: RunRequest,
  runId: string
): Promise<OpenTurn> => {
  const userMessage = createUserUIMessage(randomUUID(), body.text, { runId });

  const resolved = body.sessionId
    ? app.services.session.continueSession(body.sessionId, userMessage, runId)
    : undefined;

  // sessionId 传了但查不到 → 当成新会话(旧行为,保持)
  const { session, userMessage: storedUser } =
    resolved ?? app.services.session.createSession(userMessage, runId);

  const workspace = resolveWorkspaceForSession(
    app.services.workspaces,
    session,
    app.log
  );

  const docsSection = workspace
    ? await loadProjectDocsSection(workspace.path)
    : undefined;

  const workspaceContext: ResolvedWorkspaceContext | undefined = workspace
    ? {
      id: workspace.id,
      root: workspace.path,
      ...(docsSection !== undefined ? { docsSection } : {})
    }
    : undefined;

  return {
    sessionId: session.id,
    userMessageId: storedUser.id,
    ...(resolved === undefined ? { createdSessionId: session.id } : {}),
    ...(workspaceContext !== undefined ? { workspace: workspaceContext } : {})
  };
};

/**
 * 阶段③:模型这一轮看见什么。
 * 需要 mainModel 的窗口信息 → 必须在阶段② 解析模型之后调用。
 * userMessageId 由阶段① 产出,这里不碰 —— 模型属于 assistant 消息与 runs.model。
 */
const buildRunContext = async (
  app: FastifyInstance,
  open: OpenTurn,
  resolved: { readonly mainModel: ModelBinding; readonly toolModel: ModelBinding },
  body: RunRequest
): Promise<PreparedRun> => {
  const { mainModel } = resolved;
  new DrizzleSessionRepository(app.infra.db).updateModel(open.sessionId, mainModel.qualifiedModelId);

  const settings = loadAppSettings(app.infra.db, app.infra.config);
  await autoCompactIfNeeded(app.infra.db, open.sessionId, createAutoCompactConfig(settings.chat), {
    summarize: createModelSummarizer(resolved.toolModel, app.log)
  });

  const history = app.services.session.buildModelHistory(app.infra.db, open.sessionId);

  // ignoreIncompleteToolCalls:上一轮被 abort 时可能留下没有结果的 tool part,
  // 带着它去请求模型会被 provider 拒绝(tool_use 必须有配对的 tool_result)。
  const converted = await convertToModelMessages([...history.messages], {
    ignoreIncompleteToolCalls: true
  });

  const modelMessages: ModelMessage[] = history.summary
    ? [{ role: "system", content: history.summary }, ...converted]
    : converted;

  const memoryRuntime = await buildMemoryRuntimeSupport({
    db: app.infra.db,
    config: app.infra.config,
    userMessage: body.text,
    historyTokens: estimateModelHistoryTokens(history),
    ...(mainModel.contextWindow !== undefined || mainModel.maxOutputTokens !== undefined
      ? {
        modelLimits: {
          ...(mainModel.contextWindow !== undefined
            ? { contextWindow: mainModel.contextWindow }
            : {}),
          ...(mainModel.maxOutputTokens !== undefined
            ? { maxOutputTokens: mainModel.maxOutputTokens }
            : {})
        }
      }
      : {})
  });

  return {
    sessionId: open.sessionId,
    userMessageId: open.userMessageId,
    modelMessages,
    additionalTools: [...memoryRuntime.additionalTools],
    ...(memoryRuntime.memoryContext
      ? { context: { memory: memoryRuntime.memoryContext } }
      : {})
  };
};

export const registerRunRoutes = (app: FastifyInstance): void => {
  app.post("/api/v1/runs/stream", async (request, reply) => {
    const runId = randomUUID();
    const controller = app.services.runRegistry.register(runId);
    let finished = false;
    let sessionId = "";
    let seq = 0;
    // 供 catch 回滚 503 时新建的会话。
    let open: OpenTurn | undefined;

    // 统一的帧出口:seq 只在这里递增(generator 帧与审批帧共用同一序列)。
    const emit = (event: RunStreamEvent): void => {
      seq += 1;
      writeFrame(reply, { ...event, seq } as RunStreamFrame);
    };

    const requestApproval: RequestApproval = async ({ toolCallId, toolName, args }) => {
      const settings = loadAppSettings(app.infra.db, app.infra.config);

      if (settings.security.autoApproveToolRequests) {
        return true;
      }

      emit({ type: "approval_request", callId: toolCallId, toolName, args });
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
      open = await openSessionTurn(app, body, runId);
      sessionId = open.sessionId;

      // MCP 连接在这里懒触发(首个 run 付一次成本,之后是空调用)。连不上的 server
      // 只在 registry 里记 error,工具缺席即可 —— MCP 不可用绝不让对话失败。
      await app.services.mcp.ensureConnected();

      // 阶段②:解析模型(带工作区 + MCP 工具)。模型不可用(503)时,本次刚建的会话要回滚。
      const resolved = app.services.agents.resolve({
        ...(body.modelId !== undefined ? { requestedModelId: body.modelId } : {}),
        ...(open.workspace !== undefined ? { workspace: open.workspace } : {}),
        extraTools: app.services.mcp.listTools(),
        requestApproval
      });

      // 阶段③:模型这轮看见什么(需要 mainModel 的窗口信息)。
      const prepared = await buildRunContext(app, open, resolved, body);

      const runs = new DrizzleRunRepository(app.infra.db);
      runs.start({
        id: runId,
        sessionId,
        model: resolved.mainModel.qualifiedModelId,
        userMessageId: prepared.userMessageId
      });

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });

      emit({ type: "run_start", runId, sessionId });

      // 客户端断连检测必须挂在 response 上:Node ≥18 的 request "close"
      // 在请求体读完即触发(不等客户端断开),response "close" 才是
      // "response.end() 之前 socket 被关闭"的语义。
      reply.raw.on("close", () => {
        if (!finished) {
          app.services.runRegistry.abort(runId);
          // 别让 pending 审批吊住 agent loop —— 归属键是 runId,不需要先知道会话
          app.services.approvals.cancelByRun(runId);
        }
      });

      const builder = new UiMessageBuilder(randomUUID());
      let finishReason: StreamFinishReason = "stop";
      let usage: StreamTokenUsage | undefined;
      let streamError: string | undefined;

      for await (const event of resolved.agent.stream({
        messages: prepared.modelMessages,
        abortSignal: controller.signal,
        ...(prepared.additionalTools.length > 0
          ? { additionalTools: [...prepared.additionalTools] }
          : {}),
        ...(prepared.context !== undefined ? { context: prepared.context } : {})
      })) {
        builder.push(event);
        emit(event);

        if (event.type === "finish") {
          finishReason = event.finishReason;
          usage = event.usage;
        }

        if (event.type === "error") {
          finishReason = "error";
          streamError = event.message;
        }
      }

      const assistantMessage = builder.build({
        runId,
        model: resolved.mainModel.qualifiedModelId,
        ...(finishReason === "aborted" ? { aborted: true } : {})
      });

      // assistantMessage 无论什么终态都落库(含 aborted / error)。丢一半的回复也比
      // DB 里没痕迹强 —— metadata.aborted 标出来即可。
      const stored = app.services.session.recordAssistantMessage(
        sessionId,
        assistantMessage,
        runId
      );

      runs.settle(runId, {
        status: runStatusFor(finishReason),
        finishReason,
        assistantMessageId: stored.id,
        ...(usage !== undefined ? { usage } : {}),
        ...(streamError !== undefined ? { error: streamError } : {})
      });

      emit({ type: "end", finishReason });
      finished = true;
      reply.raw.end();
    } catch (error) {
      request.log.error({ err: error, runId }, "failed to stream agent run");

      // 模型不可用(503)且这条会话是本次请求刚建的 → 撤掉,别让没配好 API key 的
      // 新装用户每点一次发送就攒一条空会话。已有会话不动:用户说的话得留下。
      if (error instanceof AgentUnavailableError && open?.createdSessionId) {
        new DrizzleSessionRepository(app.infra.db).deleteById(open.createdSessionId);
      }

      if (sessionId) {
        new DrizzleRunRepository(app.infra.db).settle(runId, {
          status: "error",
          error: toErrorMessage(error)
        });
      }

      if (!reply.raw.headersSent) {
        reply.code(error instanceof AgentUnavailableError ? 503 : 400);

        return { error: toErrorMessage(error) };
      }

      finished = true;
      emit({ type: "error", message: toErrorMessage(error) });
      emit({ type: "end", finishReason: "error" });
      reply.raw.end();
    } finally {
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