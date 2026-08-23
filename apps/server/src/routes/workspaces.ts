import type { FastifyInstance } from "fastify";
import type { Workspace } from "@eva/shared";
import { z } from "zod";

import { UnusableWorkspacePathError } from "../services/workspaces/workspace-guard.js";
import { pickDirectory } from "../services/workspaces/directory-picker.js";

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

  // 本机原生目录选择框:server 弹系统框拿绝对路径返回,浏览器/Electron 都不用
  // 手输路径。取消 → { path: null };平台弹不出 → { path: null, unsupported: true }
  // (前端回落手输)。串行化:同时只弹一个框,避免连点叠多个原生窗。
  let picking: Promise<unknown> | null = null;
  app.post(
    "/api/v1/workspaces/pick-directory",
    async (request, reply): Promise<{ path: string | null; unsupported?: boolean }> => {
      if (picking) {
        reply.code(409);
        return { path: null };
      }
      picking = pickDirectory();
      try {
        return (await picking) as { path: string | null; unsupported?: boolean };
      } catch (error) {
        request.log.warn({ err: error }, "native directory picker unavailable");
        return { path: null, unsupported: true };
      } finally {
        picking = null;
      }
    }
  );

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