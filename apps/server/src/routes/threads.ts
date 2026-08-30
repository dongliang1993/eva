import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  SubagentMessage,
  ThreadMessage,
  ThreadStatus,
  ThreadSummary,
  ThreadUsage
} from "@eva/shared";

import type { ThreadCompactResult } from "../api/sessions-api.js";

const listThreadsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional()
});

const getThreadMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional()
});

const getSubagentMessagesQuerySchema = z.object({
  /** 子代理进程的挂点 —— 即 Task 工具那次调用的 toolCallId。 */
  toolCallId: z.string().min(1)
});

const createThreadSchema = z.object({
  title: z.string().min(1).max(200).optional()
});

const setThreadWorkspaceSchema = z.object({
  workspaceId: z.string().nullable()
});

const renameThreadSchema = z.object({
  title: z.string().min(1).max(200)
});

const NOT_FOUND = { error: "Thread not found" } as const;

export const registerThreadRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/threads", async (request): Promise<readonly ThreadSummary[]> => {
    const query = listThreadsQuerySchema.parse(request.query ?? {});

    return app.api.sessions.listSummaries(query.limit ?? 50);
  });

  app.post("/api/v1/threads", async (request, reply): Promise<ThreadSummary> => {
    const body = createThreadSchema.parse(request.body ?? {});
    reply.code(201);

    return app.api.sessions.create(body.title);
  });

  app.put(
    "/api/v1/threads/:id/workspace",
    async (request, reply): Promise<ThreadSummary | { error: string }> => {
      const { id } = request.params as { id: string };
      const body = setThreadWorkspaceSchema.parse(request.body ?? {});
      const updated = app.api.sessions.setWorkspace(id, body.workspaceId);

      if (!updated) {
        reply.code(404);
        return NOT_FOUND;
      }

      return updated;
    }
  );

  app.put(
    "/api/v1/threads/:id",
    async (request, reply): Promise<ThreadSummary | { error: string }> => {
      const { id } = request.params as { id: string };
      const body = renameThreadSchema.parse(request.body ?? {});
      const updated = app.api.sessions.rename(id, body.title);

      if (!updated) {
        reply.code(404);
        return NOT_FOUND;
      }

      return updated;
    }
  );

  app.delete("/api/v1/threads/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    if (!app.api.sessions.delete(id)) {
      reply.code(404);
      return NOT_FOUND;
    }

    reply.code(204);
    return null;
  });

  app.post(
    "/api/v1/threads/:id/compact",
    async (request, reply): Promise<ThreadCompactResult | { error: string }> => {
      const { id } = request.params as { id: string };
      const result = await app.api.sessions.compact(id);

      if (!result) {
        reply.code(404);
        return NOT_FOUND;
      }

      return result;
    }
  );

  app.get(
    "/api/v1/threads/:id/status",
    async (request, reply): Promise<ThreadStatus | { error: string }> => {
      const { id } = request.params as { id: string };
      const status = app.api.sessions.readStatus(id);

      if (!status) {
        reply.code(404);
        return NOT_FOUND;
      }

      return status;
    }
  );

  app.get(
    "/api/v1/threads/:id/usage",
    async (request, reply): Promise<ThreadUsage | { error: string }> => {
      const { id } = request.params as { id: string };
      const usage = app.api.sessions.readUsage(id);

      if (!usage) {
        reply.code(404);
        return NOT_FOUND;
      }

      return usage;
    }
  );

  app.get(
    "/api/v1/threads/:id/messages",
    async (request, reply): Promise<readonly ThreadMessage[] | { error: string }> => {
      const { id } = request.params as { id: string };
      const query = getThreadMessagesQuerySchema.parse(request.query ?? {});
      const messages = app.api.sessions.listMessages(id, query.limit ?? 200);

      if (!messages) {
        reply.code(404);
        return NOT_FOUND;
      }

      return messages;
    }
  );

  // S7:某次 Task 调用页面的子代理消息流 —— 刷新后任务卡片展开区的数据源。
  app.get(
    "/api/v1/threads/:id/subagent-messages",
    async (request, reply): Promise<SubagentMessage | { error: string }> => {
      const { id } = request.params as { id: string };
      const query = getSubagentMessagesQuerySchema.parse(request.query ?? {});
      const found = app.api.sessions.findSubagentMessages(id, query.toolCallId);

      if (!found) {
        // 会话不存在与「这个 toolCallId 下没有子代理任务」都是 404 —— 但错误信息
        // 保持区分:前者是 URL 错了,后者是卡片指向了一个不存在的任务。
        reply.code(404);
        return app.api.sessions.find(id)
          ? { error: "Subagent task not found for this tool call" }
          : NOT_FOUND;
      }

      return found;
    }
  );

  app.post(
    "/api/v1/messages/:id/switch-version",
    async (request, reply): Promise<readonly ThreadMessage[] | { error: string }> => {
      const { id } = request.params as { id: string };
      const chain = app.api.sessions.switchMessageVersion(id);

      if (!chain) {
        reply.code(404);
        return { error: "Message not found" };
      }

      return chain;
    }
  );
};
