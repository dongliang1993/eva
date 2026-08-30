import { randomUUID } from "node:crypto";

import {
  createAppendMemoryTool,
  createReadMemoryFileTool,
  createSaveMemoryTool,
  createSearchMemoryTool,
  createUpdateLongTermMemoryTool,
  type AgentTool,
  type MemoryCategory,
  type MemoryStore
} from "@eva/harness";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import { DrizzleMemoryRepository } from "./memory-repository.js";
import { DrizzleMessageSearchRepository } from "../search/index.js";
import { evaDataDir } from "../../paths.js";
import { MemoryFileStore } from "./memory-file-store.js";
import { embedAndStoreMemory } from "./memory-embedding.js";
import {
  calculateMemoryContextTokenBudget,
  recallMemories,
  renderRecallPromptContext
} from "./memory-recall.js";
import { loadAppSettings } from "../settings/index.js";

export interface MemoryRuntimeModelLimits {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export interface BuildMemoryRuntimeSupportOptions {
  readonly db: AppDatabase;
  readonly config: AppConfig;
  readonly userMessage: string;
  /** 模型这轮可见历史的 token 估算(工具轨迹计入)。 */
  readonly historyTokens: number;
  readonly baseContext?: Record<string, unknown>;
  readonly modelLimits?: MemoryRuntimeModelLimits;
}

export interface MemoryRuntimeSupport {
  readonly additionalTools: readonly AgentTool[];
  readonly memoryContext?: string;
  readonly memoryBudgetTokens: number;
  readonly usedMemoryIds: readonly string[];
}

const createMemoryStore = (
  db: AppDatabase,
  config: AppConfig
): MemoryStore => {
  const memoryRepo = new DrizzleMemoryRepository(db);

  return {
    async save(content, category, origin, sourceSessionId, sourceMessageId) {
      const input: {
        id: string;
        content: string;
        category?: MemoryCategory;
        origin?: "manual" | "tool_saved";
        sourceSessionId?: string;
        sourceMessageId?: string;
      } = { id: randomUUID(), content };
      if (category) input.category = category;
      if (origin) input.origin = origin;
      if (sourceSessionId) input.sourceSessionId = sourceSessionId;
      if (sourceMessageId) input.sourceMessageId = sourceMessageId;
      const saved = memoryRepo.save(input);

      void embedAndStoreMemory(db, config, saved.id, content).catch(() => {});

      return saved;
    },
    async search(query, limit) {
      return memoryRepo.search(query, "default", limit);
    },
    async listAll(limit) {
      return memoryRepo.listAll("default", limit);
    },
    async update(id, content, category) {
      return memoryRepo.update(id, content, category);
    },
    async deleteById(id) {
      return memoryRepo.deleteById(id);
    }
  };
};

export const buildMemoryRuntimeSupport = async (
  options: BuildMemoryRuntimeSupportOptions
): Promise<MemoryRuntimeSupport> => {
  const { db, config, userMessage, historyTokens, baseContext, modelLimits } = options;
  const settings = loadAppSettings(db, config);

  if (!settings.memory.enabled) {
    return {
      additionalTools: [],
      memoryBudgetTokens: 0,
      usedMemoryIds: []
    };
  }

  const store = createMemoryStore(db, config);
  // 人类可读记忆文件(~/.eva/MEMORY.md + memory/)在 settings.memory.enabled 之外始终挂载:
  // .enabled 管的是 DB 检索(L4),文件工具(L1/L2)是"文件即数据库"哲学的一部分,
  // 与 skills/MCP 一样只要进程活着就能用 —— 无需用户先在 Settings 打开。
  const fileStore: MemoryFileStore = new MemoryFileStore(evaDataDir());
  const additionalTools: readonly AgentTool[] = [
    createSaveMemoryTool(store),
    createSearchMemoryTool(store),
    createReadMemoryFileTool(fileStore),
    createAppendMemoryTool(fileStore),
    createUpdateLongTermMemoryTool(fileStore)
  ];
  const memoryBudgetTokens = settings.memory.autoRetrieve
    ? calculateMemoryContextTokenBudget({
      historyTokens,
      ...(baseContext !== undefined
        ? { existingContext: baseContext }
        : {}),
      ...(modelLimits?.contextWindow !== undefined
        ? { contextWindow: modelLimits.contextWindow }
        : {}),
      ...(modelLimits?.maxOutputTokens !== undefined
        ? { reservedOutputTokens: modelLimits.maxOutputTokens }
        : {})
    })
    : 0;

  if (!settings.memory.autoRetrieve || memoryBudgetTokens <= 0) {
    return {
      additionalTools,
      memoryBudgetTokens,
      usedMemoryIds: []
    };
  }

  const recallResult = await recallMemories(userMessage, {
    db,
    config,
    memoryRepo: new DrizzleMemoryRepository(db),
    messageSearch: new DrizzleMessageSearchRepository(db),
    memoryTopK: settings.memory.maxRetrievedMemories,
    similarityThreshold: settings.memory.similarityThreshold,
    queryRewriting: settings.memory.queryRewriting
  });
  const renderedContext = renderRecallPromptContext(recallResult, {
    tokenBudget: memoryBudgetTokens
  });

  return {
    additionalTools,
    ...(renderedContext.promptContext
      ? { memoryContext: renderedContext.promptContext }
      : {}),
    memoryBudgetTokens,
    usedMemoryIds: renderedContext.usedMemoryIds
  };
};
