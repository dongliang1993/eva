import { randomUUID } from "node:crypto";

import type { ModelMessage } from "ai";
import type { RequestApproval } from "@eva/harness";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RunStreamEvent, RunStreamFrame, StreamFinishReason } from "@eva/shared";
import { toErrorMessage } from "@eva/shared";

import {
  AgentUnavailableError,
  type ResolvedRuntimeModelBinding
} from "../agent.js";
import { DrizzleSessionRepository } from "../db/repositories/session-repository.js";
import { autoCompactIfNeeded, createAutoCompactConfig } from "../services/auto-compact.js";
import { buildMemoryRuntimeSupport } from "../services/memory-runtime.js";
import { loadAppSettings } from "../services/settings-store.js";
import { runSchema } from "../types/runs.js";
import type { RunInput, RunInputMessage, RunMessageContent } from "../types/runs.js";

const formatSseFrame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const writeFrame = (reply: FastifyReply, frame: RunStreamFrame): void => {
  reply.raw.write(formatSseFrame(frame.type, frame));
};

// Normalize legacy LangChain roles (human/ai/function/generic/remove) and the
// generic "developer" role down to the four Vercel ModelMessage roles.
const normalizeRole = (role: RunInputMessage["role"]): ModelMessage["role"] => {
  switch (role) {
    case "human":
      return "user";
    case "ai":
    case "function":
    case "generic":
    case "remove":
      return "assistant";
    case "developer":
      return "system";
    default:
      return role;
  }
};

const toAgentMessage = ({
  role,
  content
}: RunInputMessage): ModelMessage => ({
  role: normalizeRole(role),
  content: content as RunMessageContent
} as ModelMessage);

const toAgentRunInput = (input: RunInput) => ({
  messages: input.messages.map(toAgentMessage),
  ...(input.context !== undefined ? { context: input.context } : {}),
  ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
  ...(input.additionalTools !== undefined ? { additionalTools: input.additionalTools } : {}),
  ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {})
});

/**
 * Extract the last user message content from the request body.
 */
const extractUserContent = (
  body: ReturnType<typeof runSchema.parse>
): string => {
  const lastMessage = body.messages[body.messages.length - 1];

  return typeof lastMessage?.content === "string"
    ? lastMessage.content
    : JSON.stringify(lastMessage?.content ?? "");
};

/**
 * Resolve session context:
 * - No sessionId → create new session, return sessionId to client
 * - Has sessionId → continue existing session with history
 *
 * Returns enriched RunInput with model-visible history + the session ID.
 */
const resolveSessionInput = async (
  app: FastifyInstance,
  body: ReturnType<typeof runSchema.parse>,
  mainModel: ResolvedRuntimeModelBinding
): Promise<{ input: RunInput; sessionId: string }> => {
  const userContent = extractUserContent(body);

  const resolved = body.sessionId
    ? app.services.session.continueSession(body.sessionId, userContent)
    : undefined;

  // If sessionId was provided but not found, or no sessionId → create new
  const { session, history: rawHistory } = resolved
    ?? app.services.session.createSession(userContent);

  // Auto-compact if context is too large (before building agent messages)
  const appSettings = loadAppSettings(app.infra.db, app.infra.config);
  const compactConfig = createAutoCompactConfig(appSettings.chat);
  autoCompactIfNeeded(
    app.infra.db, session.id, rawHistory, compactConfig
  );

  const history = app.services.session.buildModelHistory(app.infra.db, session.id);

  const messages = history.map((m) => ({
    role: m.role,
    content: m.content
  }));

  // Record which model is being used on this session
  const sessionRepo = new DrizzleSessionRepository(app.infra.db);
  sessionRepo.updateModel(session.id, mainModel.qualifiedModelId);

  const memoryRuntime = await buildMemoryRuntimeSupport({
    db: app.infra.db,
    config: app.infra.config,
    userMessage: userContent,
    modelHistory: history,
    ...(body.context !== undefined
      ? { baseContext: body.context }
      : {}),
    ...(
      mainModel.contextWindow !== undefined
        || mainModel.maxOutputTokens !== undefined
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
        : {}
    )
  });

  return {
    input: {
      ...body,
      messages,
      ...(memoryRuntime.additionalTools.length > 0
        ? { additionalTools: [...memoryRuntime.additionalTools] }
        : {}),
      ...(memoryRuntime.memoryContext
        ? { context: { ...body.context, memory: memoryRuntime.memoryContext } }
        : {})
    },
    sessionId: session.id
  };
};

export const registerRunRoutes = (app: FastifyInstance): void => {
  app.post("/api/v1/runs/wait", async (request, reply) => {
    try {
      const body = runSchema.parse(request.body ?? {});
      const resolved = app.services.agents.resolve({
        ...(body.modelId !== undefined
          ? { requestedModelId: body.modelId }
          : {})
      });
      const { input, sessionId } = await resolveSessionInput(app, body, resolved.mainModel);

      const waitStart = Date.now();
      const result = await resolved.agent.invoke(toAgentRunInput(input));
      const waitDurationMs = Date.now() - waitStart;

      app.services.session.recordAssistantResult(sessionId, result, undefined, waitDurationMs);

      return { ...result, sessionId };
    } catch (error) {
      request.log.error({ err: error }, "failed to execute agent run");
      reply.code(error instanceof AgentUnavailableError ? 503 : 400);

      return {
        error: toErrorMessage(error)
      };
    }
  });

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
      const body = runSchema.parse(request.body ?? {});
      const resolved = app.services.agents.resolve({
        ...(body.modelId !== undefined
          ? { requestedModelId: body.modelId }
          : {}),
        requestApproval
      });

      const { input, sessionId: resolvedSessionId } =
        await resolveSessionInput(app, body, resolved.mainModel);
      sessionId = resolvedSessionId;

      input.abortSignal = controller.signal;

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

      let resultText = "";
      let finishReason: StreamFinishReason = "stop";
      let thinkingDurationMs: number | undefined;
      const streamStart = Date.now();
      const toolCalls: Array<{
        toolName: string;
        toolCallId: string;
        args: Record<string, unknown>;
        output: string;
        status: "success" | "error";
        durationMs?: number;
      }> = [];

      for await (const event of resolved.agent.stream(toAgentRunInput(input))) {
        emit(event);

        if (event.type === "text-delta" && thinkingDurationMs === undefined) {
          thinkingDurationMs = Date.now() - streamStart;
        }

        if (event.type === "finish") {
          resultText = event.text;
          finishReason = event.finishReason;
          toolCalls.push(...event.toolCalls.map((tc) => ({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            args: tc.args,
            output: tc.output,
            status: tc.status,
            ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {})
          })));
        }

        if (event.type === "error") {
          finishReason = "error";
        }
      }

      app.services.session.recordAssistantResult(
        sessionId,
        { text: resultText, toolCalls },
        undefined,
        thinkingDurationMs,
        finishReason === "aborted" ? { aborted: true } : undefined
      );

      emit({ type: "end", finishReason });
      finished = true;
      reply.raw.end();
    } catch (error) {
      request.log.error({ err: error }, "failed to stream agent run");

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
    const sessionId = app.services.runRegistry.abort(runId);

    if (sessionId === undefined) {
      reply.code(404);
      return { error: "run not found or already finished" };
    }

    // 中止时立刻拒绝该会话下 pending 的审批,否则 agent loop 会被吊住
    app.services.approvals.cancelBySession(sessionId);

    return { ok: true };
  });
};