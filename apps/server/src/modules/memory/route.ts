import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryRecord, MemoryStats } from "@eva/shared";

const memoryCategoryEnum = z.enum([
  "user",
  "preference",
  "project",
  "decision",
  "knowledge"
]);

const memoryBodySchema = z.object({
  content: z.string(),
  category: memoryCategoryEnum.optional()
});

export const registerMemoryRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/memories", async (): Promise<readonly MemoryRecord[]> =>
    app.api.memory.list()
  );

  app.get("/api/v1/memories/stats", async (): Promise<MemoryStats> => app.api.memory.stats());

  app.post("/api/v1/memories/search", async (request): Promise<readonly MemoryRecord[]> => {
    const { query } = z.object({ query: z.string() }).parse(request.body ?? {});

    return app.api.memory.search(query);
  });

  app.post("/api/v1/memories", async (request) => {
    const { content, category } = memoryBodySchema.parse(request.body ?? {});

    return app.api.memory.add(content, category);
  });

  app.put("/api/v1/memories/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { content, category } = memoryBodySchema.parse(request.body ?? {});
    const updated = app.api.memory.update(id, content, category);

    if (!updated) {
      reply.code(404);
      return { error: "Memory not found" };
    }

    return updated;
  });

  app.delete("/api/v1/memories/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    if (!app.api.memory.delete(id)) {
      reply.code(404);
      return { error: "Memory not found" };
    }

    reply.code(204);
    return null;
  });

  // 批量补齐 pending 的向量。
  app.post("/api/v1/memories/reindex", async () => app.api.memory.reindex());
};
