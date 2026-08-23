import path from "node:path";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { loadSkills, loadSoulSection } from "@eva/harness";

import { loadConfig, type AppConfig } from "./config.js";
import {
  initializeDatabase
} from "./db/index.js";
import { DrizzleRunRepository } from "./db/repositories/run-repository.js";
import { failStaleTasks } from "./db/repositories/background-task-repository.js";
import { ApprovalRepository } from "./db/repositories/approval-repository.js";
import { createPinoObserver } from "./observability.js";
import { clampContextWindow } from "./services/providers/context-clamp.js";
import { findMonorepoRoot } from "./services/monorepo-root.js";
import { syncMcpConfigFile } from "./services/mcp/mcp-config-file.js";
import {
  migrateLegacySettings,
  migrateSecurityToAlwaysAllowTools,
  migrateAlwaysAllowToolsToPolicies
} from "./services/settings/migrate-legacy.js";
import { secretKeyPath, userSkillsDir } from "./paths.js";
import { AesGcmEncryptor, IdentityEncryptor, type Encryptor } from "./services/crypto/encryptor.js";
import { loadSecretKey } from "./services/crypto/secret-key.js";
import type { AppInfrastructure, AppServices } from "./types/common.js";

export const buildInfrastructure = async (): Promise<AppInfrastructure> => {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const db = initializeDatabase(config, logger);
  // T38: observer 订阅超限钳制事件 → 钳小该模型 contextWindow 写 DB(持久化,下次 resolve 生效)。
  // clamp 只改 capabilities.contextWindow,不动 apiKey,encryptor 用缺省明文即可。
  const observer = createPinoObserver(logger, (clamp) => {
    clampContextWindow(db, {
      providerId: clamp.providerId,
      modelId: clamp.modelId,
      observedTokens: clamp.observedTokens
    });
  });
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

  // 一次性把旧 settings 结构迁到模型槽位(存在 models 行即幂等跳过)。
  migrateLegacySettings(db, logger);

  // T14:旧「始终允许」全局开关 → per-tool 白名单(存在 alwaysAllowTools 即幂等跳过)。
  migrateSecurityToAlwaysAllowTools(db, logger);

  // T27:per-tool 白名单 → thread 作用域 policy key(存在 allowAlwaysPolicies 即幂等跳过)。
  migrateAlwaysAllowToolsToPolicies(db, logger);

  // ~/.eva/mcp.json → mcp_servers 表（file-origin）。运行时只读表，不读文件。
  // 这里只同步配置，不建连接 —— 连接留给第一个 run 触发（没配 MCP 的用户零开销）。
  syncMcpConfigFile(db, logger);

  // 进程重启时把上次没跑完的 run 收成 error —— 否则崩溃留下的 running 行会永远挂着。
  const staleRuns = new DrizzleRunRepository(db).failStale();
  if (staleRuns > 0) {
    logger.warn({ staleRuns }, "marked in-flight runs as error after restart");
  }

  // 同样的收尾给后台子代理任务:崩溃遗留的 running 任务实为"永远等不到",
  // 收成 failed 后 join 拿到明确错误,而不是吊到 join 超时。
  const staleTasks = failStaleTasks(db);
  if (staleTasks > 0) {
    logger.warn({ staleTasks }, "marked in-flight subagent tasks as failed after restart");
  }

  // 审批不超时之后(只能人工决策 / Stop / 进程重启),重启是遗留 pending 行唯一的
  // 收尾时机 —— 不扫就会永远挂着,并让那些会话一直显示"待决策"。
  const stalePending = new ApprovalRepository(db).failStalePending();
  if (stalePending > 0) {
    logger.warn({ stalePending }, "denied pending approvals left over from previous process");
  }

  // apiKey 落库加密:key 文件读不出 → 明文降级(与 Alma 的 safeStorage 降级同款哲学,
  // docs 04 §8.3.2)—— 绝不让"key 文件损坏"变成"整个 provider 体系全灭"。
  const secretKey = loadSecretKey(secretKeyPath());
  const encryptor: Encryptor = secretKey
    ? new AesGcmEncryptor(secretKey)
    : new IdentityEncryptor();
  if (!secretKey) {
    logger.warn("apiKey 加密不可用(secret-key 读取失败),明文降级");
  }

  return {
    config,
    db,
    logger,
    skills,
    encryptor,
    observer,
    soulSection
  };
};

export const getConfig = (app: FastifyInstance): AppConfig => app.infra.config;

export const getServices = (app: FastifyInstance): AppServices => app.services;
