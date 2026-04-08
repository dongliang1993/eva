import type { FastifyInstance } from "fastify";
import type { SkillSummary } from "@eva/shared";

export const registerSkillRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/skills", async (): Promise<readonly SkillSummary[]> =>
    app.infra.skills.map((skill) => ({
      id: skill.name,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      enabled: true
    }))
  );
};
