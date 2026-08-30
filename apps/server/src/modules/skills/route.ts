import type { FastifyInstance } from "fastify";
import type { SkillSummary } from "@eva/shared";

/** Register the skills module's HTTP projection. */
export const registerSkillRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/skills", async (): Promise<readonly SkillSummary[]> =>
    app.api.skills.list()
  );
};
