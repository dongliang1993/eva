import { existsSync } from "node:fs";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { loadSkills, loadSoulSection } from "@eva/harness";

import { loadConfig, type AppConfig } from "./config.js";
import {
  closeDb,
  getDefaultDbPath,
  getWorkspaceDbPath,
  initDb,
  migrateDb,
  type AppDatabase
} from "./db/index.js";
import { createPinoObserver } from "./observability.js";
import { bootstrapLegacyLlmProviderConfig } from "./services/settings-store.js";
import type { AppInfrastructure, AppServices } from "./types/common.js";

const findWorkspaceRoot = (startDir: string): string => {
  let current = path.resolve(startDir);

  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return startDir;
    }

    current = parent;
  }
};

const isDbPermissionError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithCode = error as Error & { code?: string; cause?: unknown };
  const cause =
    errorWithCode.cause instanceof Error
      ? errorWithCode.cause
      : undefined;
  const causeWithCode = cause as (Error & { code?: string }) | undefined;

  return (
    errorWithCode.code === "SQLITE_READONLY"
    || errorWithCode.code === "EACCES"
    || errorWithCode.code === "EPERM"
    || causeWithCode?.code === "SQLITE_READONLY"
    || causeWithCode?.code === "EACCES"
    || causeWithCode?.code === "EPERM"
    || error.message.toLowerCase().includes("readonly")
    || error.message.toLowerCase().includes("permission denied")
    || cause?.message.toLowerCase().includes("readonly") === true
    || cause?.message.toLowerCase().includes("permission denied") === true
  );
};

const openAndMigrateDb = (dbPath?: string): AppDatabase => {
  const db = initDb(dbPath ? { dbPath } : {});

  try {
    migrateDb(db);
    return db;
  } catch (error) {
    closeDb(db);
    throw error;
  }
};

const initializeDatabase = (
  config: AppConfig,
  workspaceRoot: string,
  logger: pino.Logger
): AppDatabase => {
  if (config.DB_PATH) {
    const db = openAndMigrateDb(config.DB_PATH);
    logger.info({ dbPath: config.DB_PATH }, "database initialized");
    return db;
  }

  const defaultDbPath = getDefaultDbPath();

  try {
    const db = openAndMigrateDb(defaultDbPath);
    logger.info({ dbPath: defaultDbPath }, "database initialized");
    return db;
  } catch (error) {
    if (!isDbPermissionError(error)) {
      throw error;
    }

    const fallbackDbPath = getWorkspaceDbPath(workspaceRoot);
    logger.warn(
      { defaultDbPath, fallbackDbPath },
      "default database path is not writable, falling back to workspace-local storage"
    );

    const db = openAndMigrateDb(fallbackDbPath);
    logger.info({ dbPath: fallbackDbPath }, "database initialized");
    return db;
  }
};

export const buildInfrastructure = async (): Promise<AppInfrastructure> => {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });

  logger.info(
    Object.fromEntries(
      Object.entries(config).map(([k, v]) => [k, v ? "✓" : "(empty)"])
    ),
    "loaded config"
  );
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

  const db = initializeDatabase(config, workspaceRoot, logger);
  bootstrapLegacyLlmProviderConfig(db, config);

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
