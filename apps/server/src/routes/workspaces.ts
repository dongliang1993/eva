import type { FastifyInstance } from "fastify";
import type { Workspace } from "@eva/shared";
import { z } from "zod";

import { UnusableWorkspacePathError } from "../services/workspaces/workspace-guard.js";

const createWorkspaceSchema = z.object({
  path: z.string().min(1),
  name: z.string().max(200).optional()
});

const renameWorkspaceSchema = z.object({
  name: z.string().min(1).max(200)
});

export const registerWorkspaceRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/workspaces", async (): Promise<readonly Workspace[]> => {
    return app.services.workspaces.list();
  });

  app.post(
    "/api/v1/workspaces",
    async (request, reply): Promise<Workspace | { error: string }> => {
      const body = createWorkspaceSchema.parse(request.body ?? {});

      try {
        const workspace = app.services.workspaces.add({
          path: body.path,
          ...(body.name !== undefined ? { name: body.name } : {})
        });

        reply.code(201);
        return workspace;
      } catch (error) {
        if (error instanceof UnusableWorkspacePathError) {
          reply.code(400);
          // 错误消息面向用户 —— 保留 guard 抛出的原文(用户需要知道是哪个路径不对)。
          return { error: error.message };
        }

        throw error;
      }
    }
  );

  app.put(
    "/api/v1/workspaces/:id",
    async (request, reply): Promise<Workspace | { error: string }> => {
      const { id } = request.params as { id: string };
      const body = renameWorkspaceSchema.parse(request.body ?? {});

      const updated = app.services.workspaces.rename(id, body.name);

      if (!updated) {
        reply.code(404);
        return { error: "Workspace not found" };
      }

      return updated;
    }
  );

  app.delete("/api/v1/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = app.services.workspaces.remove(id);

    if (!removed) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    reply.code(204);
    return null;
  });
};