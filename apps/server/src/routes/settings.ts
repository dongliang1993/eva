import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppSettings } from "@eva/shared";

import {
  loadAppSettings,
  replaceAppSettings
} from "../services/settings-store.js";

const appSettingsSchema = z.object({
  general: z.object({
    language: z.enum(["zh", "en"]),
    theme: z.enum(["light", "dark", "system"])
  }),
  chat: z.object({
    defaultModel: z.string(),
    temperature: z.number().min(0).max(2),
    streamResponse: z.boolean(),
    autoSaveHistory: z.boolean(),
    historyRetentionDays: z.number().int().positive(),
    showTokenUsage: z.boolean(),
    enableMarkdown: z.boolean(),
    modelUsageHistory: z.record(z.string(), z.number().int().nonnegative()),
    defaultToolSelection: z.enum(["auto", "all", "none"]),
    defaultSkillSelection: z.enum(["auto", "all", "none"]),
    autoCompact: z.boolean(),
    autoCompactTokenThreshold: z.number().int().positive(),
    autoCompactMessageThreshold: z.number().int().positive()
  }),
  security: z.object({
    encryptApiKeys: z.boolean(),
    requirePassword: z.boolean(),
    sessionTimeout: z.number().int().nonnegative(),
    enableLogging: z.boolean(),
    logLevel: z.enum(["error", "warn", "info", "debug"]),
    autoApproveToolRequests: z.boolean()
  }),
  memory: z.object({
    enabled: z.boolean(),
    autoSummarize: z.boolean(),
    autoRetrieve: z.boolean(),
    queryRewriting: z.boolean(),
    maxRetrievedMemories: z.number().int().min(1).max(20),
    similarityThreshold: z.number().min(0).max(1),
    embedding: z.object({
      baseUrl: z.string(),
      apiKey: z.string(),
      model: z.string()
    }),
    toolModel: z.string().optional()
  }),
  toolModel: z.object({
    model: z.string().optional()
  }),
  webSearch: z.object({
    engine: z.enum(["google", "xiaohongshu"])
  })
});

export const registerSettingsRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/settings", async (): Promise<AppSettings> =>
    loadAppSettings(app.infra.db, app.infra.config)
  );

  app.put("/api/v1/settings", async (request): Promise<AppSettings> => {
    const body = appSettingsSchema.parse(request.body ?? {}) as AppSettings;

    const updated = replaceAppSettings(app.infra.db, app.infra.config, body);
    app.services.agents.invalidate();

    return updated;
  });
};
