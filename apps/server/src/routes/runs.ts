import type { FastifyInstance } from "fastify";

import { toErrorMessage } from "@eva/shared";
import { type AgentStreamEvent } from "@eva/harness";

import { AgentUnavailableError, resolveAgentRuntimeConfig } from "../agent.js";
import { DrizzleSessionRepository } from "../db/repositories/session-repository.js";
import { autoCompactIfNeeded, createAutoCompactConfig } from "../services/auto-compact.js";
import { buildMemoryRuntimeSupport } from "../services/memory-runtime.js";
import { loadAppSettings } from "../services/settings-store.js";
import { runSchema } from "../types/runs.js";
import type { RunInput } from "../types/runs.js";

const formatSseFrame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const streamEventToSse = (event: AgentStreamEvent): string =>
  formatSseFrame(event.type, event);

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
  body: ReturnType<typeof runSchema.parse>
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
  const runtime = resolveAgentRuntimeConfig({
    config: app.infra.config,
    db: app.infra.db,
    requestedModelId: body.modelId
  });

  if (!runtime.ok) {
    throw new AgentUnavailableError(runtime.reason);
  }

  const sessionRepo = new DrizzleSessionRepository(app.infra.db);
  sessionRepo.updateModel(session.id, runtime.value.mainModel.qualifiedModelId);

  const memoryRuntime = await buildMemoryRuntimeSupport({
    db: app.infra.db,
    config: app.infra.config,
    userMessage: userContent,
    modelHistory: history,
    ...(body.context !== undefined
      ? { baseContext: body.context }
      : {}),
    ...(
      runtime.value.mainModel.contextWindow !== undefined
        || runtime.value.mainModel.maxOutputTokens !== undefined
        ? {
          modelLimits: {
            ...(runtime.value.mainModel.contextWindow !== undefined
              ? { contextWindow: runtime.value.mainModel.contextWindow }
              : {}),
            ...(runtime.value.mainModel.maxOutputTokens !== undefined
              ? { maxOutputTokens: runtime.value.mainModel.maxOutputTokens }
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
      const { input, sessionId } = await resolveSessionInput(app, body);

      const waitStart = Date.now();
      const result = await app.services.runs.wait(input);
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
    try {
      const body = runSchema.parse(request.body ?? {});
      const { input, sessionId } = await resolveSessionInput(app, body);

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });

      let resultText = "";
      let thinkingDurationMs: number | undefined;
      const streamStart = Date.now();
      const toolCalls: Array<{
        toolName: string;
        toolCallId: string;
        args: Record<string, unknown>;
        output: string;
        status: "success" | "error";
      }> = [];

      for await (const event of app.services.runs.stream(input)) {
        reply.raw.write(streamEventToSse(event));

        // Track thinking duration: time until first text chunk
        if (event.type === "text_chunk" && thinkingDurationMs === undefined) {
          thinkingDurationMs = Date.now() - streamStart;
        }

        // Accumulate result for session persistence
        if (event.type === "result") {
          resultText = event.text;
          toolCalls.push(...event.toolCalls.map((tc) => ({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId ?? "",
            args: tc.args,
            output: tc.output,
            status: tc.status
          })));
        }
      }

      app.services.session.recordAssistantResult(
        sessionId,
        { text: resultText, toolCalls },
        undefined,
        thinkingDurationMs
      );

      reply.raw.write(formatSseFrame("end", null));
      reply.raw.end();
    } catch (error) {
      request.log.error({ err: error }, "failed to stream agent run");

      if (!reply.raw.headersSent) {
        reply.code(error instanceof AgentUnavailableError ? 503 : 400);

        return { error: toErrorMessage(error) };
      }

      reply.raw.write(
        formatSseFrame("error", { type: "error", message: toErrorMessage(error) })
      );
      reply.raw.end();
    }
  });
};
