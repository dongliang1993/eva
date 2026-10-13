import path from "node:path";

import pino from "pino";
import { loadSkills, loadSoulSection } from "@eva/harness";

import { loadConfig } from "./config.js";
import {
  getDefaultDbPath,
  initDb,
  migrateDb
} from "./db/index.js";
import { DrizzleRunRepository, interruptToolExecutions } from "./modules/runs/index.js";
import { failStaleTasks } from "./modules/subagents/index.js";
import { ApprovalRepository } from "./modules/approvals/index.js";
import {
  applyObservabilityRetention,
  sweepAbandonedOperations,
} from "./modules/observability/index.js";
import { loadAppSettings } from "./modules/settings/index.js";
import { findMonorepoRoot } from "./infrastructure/monorepo-root.js";
import { migrateMcpServersToFile } from "./modules/mcp/index.js";
import { secretKeyPath, userSkillsDir } from "./paths.js";
import {
  AesGcmEncryptor,
  IdentityEncryptor,
  type Encryptor,
} from "./infrastructure/crypto/encryptor.js";
import { loadSecretKey } from "./infrastructure/crypto/secret-key.js";
import type { AppInfrastructure } from "./types/common.js";

export const buildInfrastructure = async (): Promise<AppInfrastructure> => {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  // 先开库不迁移:MCP 数据搬家必须在 0034 删表**之前** —— initializeDatabase
  // 内部会跑 migrateDb,表一删迁移就无表可搬,用户配置(含 env 密钥)会静默丢。
  const db = initDb({ dbPath: config.DB_PATH || getDefaultDbPath() });
  migrateMcpServersToFile(db, logger);
  migrateDb(db);
  const workspaceRoot = findMonorepoRoot(process.cwd());

  // 用户技能在 ~/.eva/skills(打包后唯一可写位置);dev 时额外扫 monorepo 根的
  // skills/,方便在仓库里试写并提交。打包态 findMonorepoRoot 会退化成 cwd,
  // 那个目录不存在,scanDirectory 返回空,无副作用。
  const skills = await loadSkills(
    [
      { dir: userSkillsDir(), source: "project" },
      { dir: path.join(workspaceRoot, "skills"), source: "project" }
    ],
    {
      onInvalidSkill: (filePath) =>
        logger.warn({ filePath }, "invalid SKILL.md skipped"),
    }
  );

  logger.info(
    { skillCount: skills.length, skills: skills.map((s) => `${s.name} (${s.source})`) },
    "skills loaded"
  );

  const serverDir = path.resolve(import.meta.dirname, "..");
  const soulSection = await loadSoulSection(serverDir);

  if (soulSection) {
    logger.info("SOUL.md loaded");
  }

  // MCP 存储迁移:旧 mcp_servers 表(含 env/headers 密钥值)一次性写进
  // ~/.eva/mcp.json 后由 0034 迁移删表。已经在开库后、migrateDb 前跑过;
  // 表已删(二次启动)是幂等空转。文件已存在时不覆盖 —— 文件是新事实源。

  // 进程重启时把上次没跑完的 run 收成 error —— 否则崩溃留下的 running 行会永远挂着。
  interruptToolExecutions(db);
  const staleRuns = new DrizzleRunRepository(db).failStale();
  if (staleRuns.length > 0) {
    logger.warn({ staleRuns: staleRuns.length }, "marked in-flight runs as error after restart");
  }

  // 收尾崩溃遗留的 awaited 子代理任务，避免 transcript 永久显示 running。
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

  // T48 启动清扫第二步:给 stale Run 的 ledger 里「有 started 没 completed」的操作
  // 补 operation_abandoned(只追加,不改写)。observability 关着就不写新事件 ——
  // 清扫是写入,得尊重同一个开关。
  const observabilitySettings = loadAppSettings(db, config).observability;
  if (observabilitySettings.enabled) {
    const abandoned = sweepAbandonedOperations(
      db,
      logger,
      observabilitySettings.captureContent,
      staleRuns
    );
    if (abandoned > 0) {
      logger.warn({ abandoned }, "appended operation_abandoned for unclosed operations");
    }
  }

  // T48 启动清扫第三步:retention(按天 + 按容量,整 Run 粒度)。删除不是"记录",
  // 不受 enabled 闸 —— 关掉观测也不该让旧 ledger 无限期留下去。
  applyObservabilityRetention(db, observabilitySettings, logger);

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
    soulSection
  };
};
