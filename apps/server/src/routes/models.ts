import type { FastifyInstance } from "fastify";
import type { ModelSummary } from "@eva/shared";

import { listModelSummaries } from "../services/settings-store.js";

export const registerModelRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/models", async (): Promise<readonly ModelSummary[]> =>
    listModelSummaries(app.infra.db)
  );
};
