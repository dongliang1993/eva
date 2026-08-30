import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ThreadSearchResult } from "@eva/shared";

const searchThreadsQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional()
});

export const registerSearchRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/search/threads", async (request): Promise<readonly ThreadSearchResult[]> => {
    const query = searchThreadsQuerySchema.parse(request.query ?? {});

    return app.api.search.searchThreads(query.q ?? "", query.limit ?? 20);
  });
};
