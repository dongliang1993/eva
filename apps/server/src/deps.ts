import path from "node:path";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { loadSkills, loadSoulSection } from "@eva/harness";

import { loadConfig, type AppConfig } from "./config.js";
import {
  initializeDatabase
} from "./db/index.js";
import { createPinoObserver } from "./observability.js";
import { findWorkspaceRoot } from "./services/workspace/index.js";
import type { AppInfrastructure, AppServices } from "./types/common.js";

export const buildInfrastructure = async (): Promise<AppInfrastructure> => {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const observer = createPinoObserver(logger);
  const workspaceRoot = findWorkspaceRoot(process.cwd());

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

  // fs 工具工作区根:优先 TARGET_REPO_ROOT(对话仓库),否则用 activity 默认目录。
  // TODO(T0.3):改为显式工作区,未配置时不注入 fs 工具。
  const workRoot = config.TARGET_REPO_ROOT.trim()
    || config.DB_PATH.split("/").slice(0, -2).join("/");

  return {
    config,
    db,
    skills,
    observer,
    soulSection,
    ...(workRoot !== undefined ? { workRoot } : {})
  };
};

export const getConfig = (app: FastifyInstance): AppConfig => app.infra.config;

export const getServices = (app: FastifyInstance): AppServices => app.services;
