import type { AppDatabase } from "../../db/index.js";
import { providers, settings } from "../../db/schema.js";
import { eq } from "drizzle-orm";

/** 只需要 info / warn 的结构化日志接口 —— 兼容 Fastify 的 logger 与 pino logger。 */
interface InfoLogger {
  info(object: unknown, message?: string): void;
  warn(object: unknown, message?: string): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readBlock = (db: AppDatabase, key: string): Record<string, unknown> | undefined => {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return undefined;

  try {
    const parsed = JSON.parse(row.value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * R2 T7 一次性迁移:把旧 settings 结构搬到 models 槽位。
 *
 * 旧结构里"哪个模型干哪件事"散在四处(chat.defaultModel / toolModel.model /
 * memory.toolModel / memory.embedding.model),且 embedding 的 provider 配置
 * 是绕开 providers 表的裸字段。这里搬一次,之后代码只认 settings.models。
 *
 * 迁移完成的标志：settings 表里存在 `models` 行。R3 可删本文件。
 */
export const migrateLegacySettings = (db: AppDatabase, logger: InfoLogger): void => {
  const alreadyMigrated = db.select().from(settings).where(eq(settings.key, "models")).get();
  if (alreadyMigrated) return;

  const chat = readBlock(db, "chat");
  const toolModel = readBlock(db, "toolModel");
  const memory = readBlock(db, "memory");

  // chat.defaultModel 不再搬:主对话模型已是 per-run 决策,没有全局槽位可搬进去。
  const toolModelValue =
    (typeof toolModel?.model === "string" && toolModel.model)
    || (typeof memory?.toolModel === "string" && memory.toolModel)
    || "";

  // embedding 三个字段齐全 → 在 providers 表建一条并指向它
  let embeddingRef: string | undefined;
  const embedding = isRecord(memory?.embedding) ? memory.embedding : undefined;
  if (
    embedding
    && typeof embedding.baseUrl === "string" && embedding.baseUrl
    && typeof embedding.apiKey === "string" && embedding.apiKey
    && typeof embedding.model === "string" && embedding.model
  ) {
    const providerId = "embedding-migrated";
    const existingProvider = db.select().from(providers).where(eq(providers.id, providerId)).get();
    const row = {
      id: providerId,
      name: "Embedding (migrated)",
      type: "custom",
      enabled: true,
      apiKey: embedding.apiKey,
      baseUrl: embedding.baseUrl,
      models: JSON.stringify([{ id: embedding.model, name: embedding.model }])
    };
    if (existingProvider) {
      db.update(providers).set(row).where(eq(providers.id, providerId)).run();
    } else {
      db.insert(providers).values({ ...row, availableModels: "[]" }).run();
    }
    embeddingRef = `${providerId}:${embedding.model}`;
  }

  const modelsBlock = {
    ...(toolModelValue ? { tool: toolModelValue } : {}),
    ...(embeddingRef ? { embedding: embeddingRef } : {})
  };
  db.insert(settings).values({ key: "models", value: JSON.stringify(modelsBlock) }).run();

  // 重写 chat / memory 行(去掉已搬走与零行为的字段);删 toolModel / general / webSearch。
  const rewriteBlock = (key: string, value: Record<string, unknown>) => {
    db.delete(settings).where(eq(settings.key, key)).run();
    db.insert(settings).values({ key, value: JSON.stringify(value) }).run();
  };

  if (chat) {
    rewriteBlock("chat", {
      temperature: chat.temperature,
      autoCompact: chat.autoCompact,
      autoCompactTokenThreshold: chat.autoCompactTokenThreshold,
      autoCompactMessageThreshold: chat.autoCompactMessageThreshold
    });
  }
  if (memory) {
    rewriteBlock("memory", {
      enabled: memory.enabled,
      autoSummarize: memory.autoSummarize,
      autoRetrieve: memory.autoRetrieve,
      queryRewriting: memory.queryRewriting,
      maxRetrievedMemories: memory.maxRetrievedMemories,
      similarityThreshold: memory.similarityThreshold
    });
  }

  for (const deadKey of ["toolModel", "general", "webSearch"]) {
    db.delete(settings).where(eq(settings.key, deadKey)).run();
  }

  logger.info(
    {
      toolModel: toolModelValue || undefined,
      embedding: embeddingRef
    },
    "settings migrated to model slots"
  );
};

/** 旧「始终允许」全局开关对应的危险工具名(T14 §2.1)。 */
const LEGACY_AUTO_APPROVE_TOOLS = ["bash", "write", "edit"] as const;

/**
 * T14 一次性迁移:「始终允许」全局开关 → per-tool 白名单。
 *
 * 旧 `security.autoApproveToolRequests` 是核按钮,点了放开**所有**危险工具。
 * 它没有逼问"你信任哪个工具",所以迁移时把旧信任范围翻译成那份白名单。
 * 迁移标志:`security` 行里已含 `alwaysAllowTools` 字段(幂等)。
 *
 * 入口文件末尾 R3 可连同上面 models 迁移一起删本文件。
 */
export const migrateSecurityToAlwaysAllowTools = (
  db: AppDatabase,
  logger: InfoLogger
): void => {
  const security = readBlock(db, "security");
  if (!security) return;

  // 幂等:已经迁过(存在 alwaysAllowTools,无论空数组还是列表)就不再动。
  if ("alwaysAllowTools" in security) return;

  const oldFlag = security.autoApproveToolRequests;

  // 落库时剔除旧开关字段,只保留新白名单。
  const dropLegacyFlag = (obj: Record<string, unknown>): Record<string, unknown> => {
    const { autoApproveToolRequests: _legacy, ...rest } = obj;
    // _legacy 刻意丢弃:迁移后只有 alwaysAllowTools 有意义。
    void _legacy;
    return rest;
  };

  const list = oldFlag === true ? [...LEGACY_AUTO_APPROVE_TOOLS] : [];

  // 先删旧行再插入,避免 settings.key 唯一约束冲突;dropLegacyFlag 顺便剔除旧开关。
  db.delete(settings).where(eq(settings.key, "security")).run();
  db.insert(settings).values({
    key: "security",
    value: JSON.stringify({ ...dropLegacyFlag(security), alwaysAllowTools: list })
  }).run();

  if (oldFlag === true) {
    logger.warn(
      { alwaysAllowTools: list },
      "安全设置迁移:全局自动审批已拆成 per-tool 白名单,按原有信任范围填入"
    );
  }
};

/**
 * T27 一次性迁移:全局 per-tool 白名单 → thread 作用域 policy key。
 *
 * 旧 `alwaysAllowTools` 是「整工具 × 全局」——点一次「始终允许 bash」就把所有会话的
 * 所有 bash 命令永久放开。新形态是 Alma 的 thread 作用域 policy key(22 §3.1)。
 * 旧白名单不知道用户想在哪个会话放哪条命令,只能折成显式全局兜底 `thread:global`。
 * 迁移标志:`security` 行里已含 `allowAlwaysPolicies` 字段(幂等,无论空数组还是列表)。
 */
export const migrateAlwaysAllowToolsToPolicies = (
  db: AppDatabase,
  logger: InfoLogger
): void => {
  const security = readBlock(db, "security");
  if (!security) return;

  // 幂等:已经迁过(存在 allowAlwaysPolicies)就不再动,也不清空 alwaysAllowTools。
  if ("allowAlwaysPolicies" in security) return;

  const oldList = Array.isArray(security.alwaysAllowTools)
    ? security.alwaysAllowTools.filter((t): t is string => typeof t === "string")
    : [];

  const toPolicyKey = (tool: string): string | undefined => {
    if (tool === "bash" || tool === "write" || tool === "edit") {
      return `${tool}:thread:global:all`;
    }
    if (tool.startsWith("mcp__")) {
      // 旧白名单只到整工具,不知道用户想放哪个具体工具 → 折成整域。
      return "mcp:thread:global:all";
    }
    return undefined; // 无法识别的条目跳过,不臆造
  };

  const policies = [...new Set(oldList.map(toPolicyKey).filter((k): k is string => !!k))];

  // 先删旧行再插入;T31 迁完即净 —— security 只留 logLevel + policies,
  // 不再残留 alwaysAllowTools 这个键(退役第二个事实源)。
  const { alwaysAllowTools: _retired, ...rest } = security;
  void _retired;
  db.delete(settings).where(eq(settings.key, "security")).run();
  db.insert(settings).values({
    key: "security",
    value: JSON.stringify({ ...rest, allowAlwaysPolicies: policies })
  }).run();

  if (policies.length > 0) {
    logger.warn(
      { allowAlwaysPolicies: policies },
      "安全设置迁移:全局白名单已折成 thread 作用域 policy key(thread:global 兜底),原白名单已清空"
    );
  }
};