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
import { syncMcpConfigFile } from "./services/mcp/mcp-config-file.js";
import {
  migrateLegacySettings,
  migrateSecurityToAlwaysAllowTools
} from "./services/settings/migrate-legacy.js";
import { userSkillsDir } from "./paths.js";
import type { AppInfrastructure, AppServices } from "./types/common.js";

export const buildInfrastructure = async (): Promise<AppInfrastructure> => {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const observer = createPinoObserver(logger);
  const workspaceRoot = findMonorepoRoot(process.cwd());

  // 用户技能在 ~/.eva/skills(打包后唯一可写位置);dev 时额外扫 monorepo 根的
  // skills/,方便在仓库里试写并提交。打包态 findMonorepoRoot 会退化成 cwd,
  // 那个目录不存在,scanDirectory 返回空,无副作用。
  const skills = await loadSkills([
    { dir: userSkillsDir(), source: "project" },
    { dir: path.join(workspaceRoot, "skills"), source: "project" }
  ]);

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

  // T14:旧「始终允许」全局开关 → per-tool 白名单(存在 alwaysAllowTools 即幂等跳过)。
  migrateSecurityToAlwaysAllowTools(db, logger);

  // ~/.eva/mcp.json → mcp_servers 表（file-origin）。运行时只读表，不读文件。
  // 这里只同步配置，不建连接 —— 连接留给第一个 run 触发（没配 MCP 的用户零开销）。
  syncMcpConfigFile(db, logger);

  // 进程重启时把上次没跑完的 run 收成 error —— 否则崩溃留下的 running 行会永远挂着。
  const staleRuns = new DrizzleRunRepository(db).failStale();
  if (staleRuns > 0) {
    logger.warn({ staleRuns }, "marked in-flight runs as error after restart");
  }

  return {
    config,
    db,
    logger,
    skills,
    observer,
    soulSection
  };
};

export const getConfig = (app: FastifyInstance): AppConfig => app.infra.config;

export const getServices = (app: FastifyInstance): AppServices => app.services;
