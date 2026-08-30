import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppSettings } from "@eva/shared";

const appSettingsSchema = z.object({
  // 没有 chat —— 主对话模型 per-run 由请求的 modelId 给,不是全局设置项。
  models: z.object({
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
    allowAlwaysPolicies: z.array(z.string())
  }),
  // 无设置页 UI,允许调用方不回传;缺省时 replaceAppSettings 保留现值。
  observability: z.object({
    enabled: z.boolean(),
    captureContent: z.enum(["off", "redacted", "full"]),
    retentionDays: z.number().int().min(0),
    maxDatabaseBytes: z.number().int().positive()
  }).optional()
});

export const registerSettingsRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/settings", async (): Promise<AppSettings> => app.api.settings.read());

  app.put("/api/v1/settings", async (request): Promise<AppSettings> =>
    // AgentFactory 失效在 api.settings.replace 里 —— 它是「改设置」这个用例的一部分。
    app.api.settings.replace(appSettingsSchema.parse(request.body ?? {}) as AppSettings)
  );
};