import { randomUUID } from "node:crypto";

import { convertToModelMessages, type ModelMessage } from "ai";
import type { RequestApproval } from "@eva/harness";
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  EvaUIMessage,
  RunStreamEvent,
  RunStreamFrame,
  StreamFinishReason,
  StreamTokenUsage
} from "@eva/shared";
import {
  UiMessageBuilder,
  createUserUIMessage,
  toErrorMessage,
  uiMessageText
} from "@eva/shared";

import {
  AgentUnavailableError,
  type ResolvedRuntimeModelBinding
} from "../agent.js";
import { DrizzleRunRepository, runStatusFor } from "../db/repositories/run-repository.js";
import { DrizzleSessionRepository } from "../db/repositories/session-repository.js";
import { autoCompactIfNeeded, createAutoCompactConfig } from "../services/auto-compact.js";
import { buildMemoryRuntimeSupport } from "../services/memory-runtime.js";
import { loadAppSettings } from "../services/settings-store.js";
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

/**
 * 落库用户消息 → 必要时 compact → 组装模型可见的消息序列。
 */
const prepareRun = async (
  app: FastifyInstance,
  body: RunRequest,
  runId: string,
  mainModel: ResolvedRuntimeModelBinding
): Promise<PreparedRun> => {
  const userMessage = createUserUIMessage(randomUUID(), body.text, {
    runId,
    model: mainModel.qualifiedModelId
  });

  const resolved = body.sessionId
    ? app.services.session.continueSession(body.sessionId, userMessage, runId)
    : undefined;

  // sessionId 传了但查不到 → 当成新会话(旧行为,保持)
  const { session, userMessage: storedUser } =
    resolved ?? app.services.session.createSession(userMessage, runId);

  new DrizzleSessionRepository(app.infra.db)
    .updateModel(session.id, mainModel.qualifiedModelId);

  const settings = loadAppSettings(app.infra.db, app.infra.config);
  autoCompactIfNeeded(app.infra.db, session.id, createAutoCompactConfig(settings.chat));

  const history = app.services.session.buildModelHistory(app.infra.db, session.id);

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
    modelHistory: history.messages.map((m) => ({ content: uiMessageText(m) })),
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
    sessionId: session.id,
    userMessageId: storedUser.id,
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
      const approved = await app.services.approvals.ask(toolCallId, sessionId, toolName, args);
      emit({ type: "approval_resolved", callId: toolCallId, approved });

      return approved;
    };

    try {
      const body = runRequestSchema.parse(request.body ?? {});
      const resolved = app.services.agents.resolve({
        ...(body.modelId !== undefined ? { requestedModelId: body.modelId } : {}),
        requestApproval
      });

      const prepared = await prepareRun(app, body, runId, resolved.mainModel);
      sessionId = prepared.sessionId;

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
          const abortedSessionId = app.services.runRegistry.abort(runId);
          // 别让 pending 审批吊住 agent loop
          if (abortedSessionId) {
            app.services.approvals.cancelBySession(abortedSessionId);
          }
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
      // pending 审批要么已被决策、要么被上面 cancelBySession 清掉;这里兜底。
      if (sessionId) {
        app.services.approvals.cancelBySession(sessionId);
      }
    }
  });

  app.post("/api/v1/runs/:runId/abort", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const abortedSessionId = app.services.runRegistry.abort(runId);

    if (abortedSessionId === undefined) {
      reply.code(404);
      return { error: "run not found or already finished" };
    }

    // 中止时立刻拒绝该会话下 pending 的审批,否则 agent loop 会被吊住
    app.services.approvals.cancelBySession(abortedSessionId);

    return { ok: true };
  });
};

// 保留 EvaUIMessage 类型引用供未来 run 台账查询接口复用。
export type { EvaUIMessage };