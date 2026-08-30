import type { FastifyInstance } from "fastify";
import type { ModelSummary } from "@eva/shared";

/** 所有 enabled provider 的模型目录,产出 qualified id(供 UI 选择器)。 */
export const registerModelRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/models", async (): Promise<readonly ModelSummary[]> =>
    app.api.providers.listModelSummaries()
  );
};
