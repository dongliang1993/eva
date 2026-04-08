import { createAgentResolver } from "../agent.js";
import { DrizzleSessionRepository } from "../db/repositories/session-repository.js";
import { DrizzleMessageRepository } from "../db/repositories/message-repository.js";
import type { AppInfrastructure, AppServices } from "../types/common.js";
import { RunApiService } from "./runs.js";
import { SessionService } from "./session.js";

export const buildAppServices = (infra: AppInfrastructure): AppServices => {
  const session = new SessionService(
    new DrizzleSessionRepository(infra.db),
    new DrizzleMessageRepository(infra.db)
  );
  const resolveAgent = createAgentResolver({
    config: infra.config,
    db: infra.db,
    skills: [...infra.skills],
    ...(infra.soulSection !== undefined ? { soulSection: infra.soulSection } : {}),
    ...(infra.observer !== undefined ? { observer: infra.observer } : {})
  });

  return {
    runs: new RunApiService(resolveAgent),
    session
  };
};
