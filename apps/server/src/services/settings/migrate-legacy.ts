import type { AppDatabase } from "../../db/index.js";
import { providers, settings } from "../../db/schema.js";
import { eq } from "drizzle-orm";

/** 只需要 info 的结构化日志接口 —— 兼容 Fastify 的 logger 与 pino logger。 */
interface InfoLogger {
  info(object: unknown, message?: string): void;
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

  const chatModel = typeof chat?.defaultModel === "string" ? chat.defaultModel : "";
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
    ...(chatModel ? { chat: chatModel } : {}),
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
      chatModel: chatModel || undefined,
      toolModel: toolModelValue || undefined,
      embedding: embeddingRef
    },
    "settings migrated to model slots"
  );
};