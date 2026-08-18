import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import pino from "pino";
import { loadSkills, loadSoulSection } from "@eva/harness";

import { loadConfig, type AppConfig } from "./config.js";
import {
  initializeDatabase
} from "./db/index.js";
import { DrizzleRunRepository } from "./db/repositories/run-repository.js";
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

  // 进程重启时把上次没跑完的 run 收成 error —— 否则崩溃留下的 running 行会永远挂着。
  const staleRuns = new DrizzleRunRepository(db).failStale();
  if (staleRuns > 0) {
    logger.warn({ staleRuns }, "marked in-flight runs as error after restart");
  }

  const workRoot = resolveWorkRoot(config.TARGET_REPO_ROOT, logger);

  return {
    config,
    db,
    skills,
    observer,
    soulSection,
    ...(workRoot !== null ? { workRoot } : {})
  };
};

/**
 * 解析 fs 工具的工作区根。
 *
 * 为什么必须显式:一个落到 $HOME 或 App 资源目录的 agent(写文件/bash)是不可见
 * 的危险 —— 能力缺失是可见的,指向错误目录的能力是不可见的。
 *
 * @returns 合法工作区绝对路径,或 null(不注入 fs 工具)。
 */
const resolveWorkRoot = (raw: string, logger: Logger): string | null => {
  const trimmed = raw.trim();

  if (!trimmed) {
    logger.warn(
      "TARGET_REPO_ROOT 未设置 —— 文件系统工具(read/write/edit/bash/grep/list)不会注入。"
        + "设置为一个明确的项目目录后重启。"
    );
    return null;
  }

  const absolute = path.resolve(trimmed);

  if (!existsSync(absolute)) {
    logger.error({ workRoot: absolute }, "TARGET_REPO_ROOT 指向的目录不存在;fs 工具不注入。");
    return null;
  }

  // 家目录 / 根目录作为工作区几乎总是配置错误,宁可拒绝
  if (absolute === os.homedir() || absolute === path.parse(absolute).root) {
    logger.error({ workRoot: absolute }, "TARGET_REPO_ROOT 不能是家目录或文件系统根;fs 工具不注入。");
    return null;
  }

  logger.info({ workRoot: absolute }, "fs 工具工作区根");
  return absolute;
};

export const getConfig = (app: FastifyInstance): AppConfig => app.infra.config;

export const getServices = (app: FastifyInstance): AppServices => app.services;
