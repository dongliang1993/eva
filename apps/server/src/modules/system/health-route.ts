import type { FastifyInstance } from "fastify";
import type { HealthStatus } from "@eva/shared";

/** Register process-health HTTP endpoints. */
export const registerHealthRoutes = (app: FastifyInstance): void => {
  app.get("/v1/health", async (): Promise<HealthStatus> => ({
    status: "ok",
    timestamp: new Date().toISOString()
  }));
};
