import type { FastifyInstance } from "fastify";
import type { SkillSummary } from "@eva/shared";

export const registerSkillRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/skills", async (): Promise<readonly SkillSummary[]> =>
    app.api.skills.list()
  );
};
