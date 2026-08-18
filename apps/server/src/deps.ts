import path from "node:path";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { loadSkills, loadSoulSection } from "@eva/harness";

import { loadConfig, type AppConfig } from "./config.js";
import {
  initializeDatabase
} from "./db/index.js";
import { DrizzleRunRepository } from "./db/repositories/run-repository.js";
import { createPinoObserver } from "./observability.js";
import { findMonorepoRoot } from "./services/monorepo-root.js";
import { migrateLegacySettings } from "./services/settings/migrate-legacy.js";
import type { AppInfrastructure, AppServices } from "./types/common.js";

export const buildInfrastructure = async (): Promise<AppInfrastructure> => {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const observer = createPinoObserver(logger);
  const workspaceRoot = findMonorepoRoot(process.cwd());

  const projectSkillsDir = path.join(
    workspaceRoot,
    "skills"
  );
  const skills = await loadSkills(projectSkillsDir);

  logger.info(
    { skillCount: skills.length, skills: skills.map((s) => `${s.name} (${s.source})`) },
    "skills loaded"
  );

  const serverDir = path.resolve(import.meta.dirname, "..");
  const soulSection = await loadSoulSection(serverDir);

  if (soulSection) {
    logger.info("SOUL.md loaded");
  }

  const db = initializeDatabase(config, logger);

  // 一次性把旧 settings 结构迁到模型槽位(存在 models 行即幂等跳过)。
  migrateLegacySettings(db, logger);

  // 进程重启时把上次没跑完的 run 收成 error —— 否则崩溃留下的 running 行会永远挂着。
  const staleRuns = new DrizzleRunRepository(db).failStale();
  if (staleRuns > 0) {
    logger.warn({ staleRuns }, "marked in-flight runs as error after restart");
  }

  return {
    config,
    db,
    skills,
    observer,
    soulSection
  };
};

export const getConfig = (app: FastifyInstance): AppConfig => app.infra.config;

export const getServices = (app: FastifyInstance): AppServices => app.services;
