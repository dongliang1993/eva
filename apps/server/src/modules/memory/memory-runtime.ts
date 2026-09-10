import { randomUUID } from "node:crypto";

import {
  createAppendMemoryTool,
  createReadMemoryFileTool,
  createSaveMemoryTool,
  createSearchMemoryTool,
  createUpdateLongTermMemoryTool,
  type AgentTool,
  type MemoryStore
} from "@eva/harness";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import { DrizzleMemoryRepository } from "./memory-repository.js";
import { evaDataDir } from "../../paths.js";
import { MemoryFileStore } from "./memory-file-store.js";
import { loadAppSettings } from "../settings/index.js";

interface RunMemoryContext {
  readonly workspaceId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly runId?: string | undefined;
  readonly userMessageId?: string | undefined;
  readonly enabled?: boolean | undefined;
}

const createMemoryStore = (
  db: AppDatabase,
  context: RunMemoryContext
): MemoryStore => {
  const memoryRepo = new DrizzleMemoryRepository(db);
  const visibleScopes = context.workspaceId ? [`workspace:${context.workspaceId}`, "global"] : ["global"];
  const canModify = (id: string): boolean => {
    const memory = memoryRepo.findById(id);
    return !!memory && memory.userId === "default" && memory.status === "active"
      && visibleScopes.includes(memory.scopeKey);
  };

  return {
    async save(content, category, origin, sourceSessionId, sourceMessageId) {
      return memoryRepo.save({
        id: randomUUID(), content,
        ...(category ? { category } : {}),
        ...(origin ? { origin } : {}),
        scopeKey: context.workspaceId && (category === "project" || category === "decision")
          ? `workspace:${context.workspaceId}` : "global",
        ...(context.sessionId || sourceSessionId ? { sourceSessionId: context.sessionId ?? sourceSessionId! } : {}),
        ...(context.userMessageId || sourceMessageId ? { sourceMessageId: context.userMessageId ?? sourceMessageId! } : {}),
        ...(context.runId ? { sourceRunId: context.runId } : {})
      });
    },
    async search(query, limit) {
      return memoryRepo.searchRelevant(query, visibleScopes, "default", limit);
    },
    async listAll(limit) {
      return memoryRepo.listActiveInScopes(visibleScopes, "default", limit);
    },
    async update(id, content, category) {
      if (!canModify(id)) throw new Error("Memory is not available in this workspace");
      return memoryRepo.update(id, content, category);
    },
    async deleteById(id) {
      if (!canModify(id)) return false;
      return memoryRepo.deleteById(id);
    }
  };
};

/** File memory is always available; the setting controls searchable database facts. */
export const createMemoryTools = (
  db: AppDatabase,
  config: AppConfig,
  context: RunMemoryContext = {}
): readonly AgentTool[] => {
  const fileStore = new MemoryFileStore(evaDataDir());
  const tools = [
    createReadMemoryFileTool(fileStore),
    createAppendMemoryTool(fileStore),
    createUpdateLongTermMemoryTool(fileStore)
  ];
  if (context.enabled ?? loadAppSettings(db, config).memory.enabled) {
    const store = createMemoryStore(db, context);
    tools.push(createSaveMemoryTool(store), createSearchMemoryTool(store));
  }
  return tools;
};
