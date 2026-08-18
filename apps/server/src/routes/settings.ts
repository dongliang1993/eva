import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppSettings } from "@eva/shared";

import {
  loadAppSettings,
  replaceAppSettings
} from "../services/settings/app-settings.js";

const appSettingsSchema = z.object({
  models: z.object({
    chat: z.string(),
    tool: z.string().optional(),
    embedding: z.string().optional()
  }),
  chat: z.object({
    temperature: z.number().min(0).max(2),
    autoCompact: z.boolean(),
    autoCompactTokenThreshold: z.number().int().positive(),
    autoCompactMessageThreshold: z.number().int().positive()
  }),
  memory: z.object({
    enabled: z.boolean(),
    autoSummarize: z.boolean(),
    autoRetrieve: z.boolean(),
    queryRewriting: z.boolean(),
    maxRetrievedMemories: z.number().int().min(1).max(20),
    similarityThreshold: z.number().min(0).max(1)
  }),
  security: z.object({
    logLevel: z.enum(["error", "warn", "info", "debug"]),
    autoApproveToolRequests: z.boolean()
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