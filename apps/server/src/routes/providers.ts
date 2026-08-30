import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  Provider,
  ProviderConnectionTestResult,
  ProviderModel,
  ProviderModelsPayload,
  ProviderSpec,
  ProviderType
} from "@eva/shared";

import type {
  ProviderCreateInput,
  ProviderUpdateInput
} from "../services/providers/provider-repository.js";
import { ProviderHttpError } from "../services/providers/provider-http.js";

const providerTypeSchema = z.enum([
  "openai",
  "anthropic",
  "deepseek",
  "openrouter",
  "moonshot",
  "aihubmix",
  "custom"
]);

const providerModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  capabilities: z.object({
    vision: z.boolean().optional(),
    imageOutput: z.boolean().optional(),
    functionCalling: z.boolean().optional(),
    functionCallingViaXml: z.boolean().optional(),
    jsonMode: z.boolean().optional(),
    streaming: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional()
  }).partial().optional(),
  isManual: z.boolean().optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional()
});

const createProviderSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  type: providerTypeSchema,
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  enabled: z.boolean().optional(),
  models: z.array(providerModelSchema).optional(),
  availableModels: z.array(providerModelSchema).optional()
});

const updateProviderSchema = z.object({
  name: z.string().min(1).optional(),
  type: providerTypeSchema.optional(),
  apiKey: z.string().optional(),
  clearApiKey: z.boolean().optional(),
  baseURL: z.string().optional(),
  enabled: z.boolean().optional(),
  models: z.array(providerModelSchema).optional(),
  availableModels: z.array(providerModelSchema).optional()
});

const providerRuntimeOverrideSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional()
});

const updateProviderModelsSchema = z.object({
  models: z.array(providerModelSchema)
});

const normalizeProviderModels = (
  models: z.infer<typeof providerModelSchema>[]
): readonly ProviderModel[] =>
  models.map((model) => {
    const capabilities = model.capabilities
      ? {
        ...(model.capabilities.vision !== undefined ? { vision: model.capabilities.vision } : {}),
        ...(model.capabilities.imageOutput !== undefined ? { imageOutput: model.capabilities.imageOutput } : {}),
        ...(model.capabilities.functionCalling !== undefined ? { functionCalling: model.capabilities.functionCalling } : {}),
        ...(model.capabilities.functionCallingViaXml !== undefined ? { functionCallingViaXml: model.capabilities.functionCallingViaXml } : {}),
        ...(model.capabilities.jsonMode !== undefined ? { jsonMode: model.capabilities.jsonMode } : {}),
        ...(model.capabilities.streaming !== undefined ? { streaming: model.capabilities.streaming } : {}),
        ...(model.capabilities.reasoning !== undefined ? { reasoning: model.capabilities.reasoning } : {}),
        ...(model.capabilities.contextWindow !== undefined ? { contextWindow: model.capabilities.contextWindow } : {}),
        ...(model.capabilities.maxOutputTokens !== undefined ? { maxOutputTokens: model.capabilities.maxOutputTokens } : {})
      }
      : undefined;

    return {
      id: model.id,
      name: model.name,
      ...(capabilities !== undefined && Object.keys(capabilities).length > 0
        ? { capabilities }
        : {}),
      ...(model.isManual !== undefined ? { isManual: model.isManual } : {}),
      ...(model.providerOptions !== undefined ? { providerOptions: model.providerOptions } : {})
    };
  });

export const registerProviderRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/providers", async (): Promise<readonly Provider[]> =>
    app.api.providers.list()
  );

  // provider 静态知识(不含密钥),frontend 用 staleTime=Infinity 缓存。
  app.get("/api/v1/provider-catalog", async (): Promise<readonly ProviderSpec[]> =>
    app.api.providers.catalog()
  );

  app.post("/api/v1/providers", async (request, reply): Promise<Provider | { error: string }> => {
    const body = createProviderSchema.parse(request.body ?? {});

    if (body.id && app.api.providers.exists(body.id)) {
      reply.code(409);
      return { error: `Provider "${body.id}" already exists` };
    }

    const input: ProviderCreateInput = {
      name: body.name,
      type: body.type as ProviderType,
      ...(body.id !== undefined ? { id: body.id } : {}),
      ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
      ...(body.baseURL !== undefined ? { baseURL: body.baseURL } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.models !== undefined ? { models: normalizeProviderModels(body.models) } : {}),
      ...(body.availableModels !== undefined
        ? { availableModels: normalizeProviderModels(body.availableModels) }
        : {})
    };
    reply.code(201);
    // AgentFactory 失效在 api.providers 内部 —— 每条写路径都要,不该由 7 个 handler 各记一遍。
    return app.api.providers.create(input);
  });

  app.post(
    "/api/v1/providers/:id/test",
    async (request, reply): Promise<ProviderConnectionTestResult | { error: string }> => {
      const { id } = request.params as { id: string };
      const body = providerRuntimeOverrideSchema.parse(request.body ?? {});
      const result = await app.api.providers.testConnection(id, {
        ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
        ...(body.baseURL !== undefined ? { baseURL: body.baseURL } : {})
      });

      if (!result) {
        reply.code(404);
        return { error: "Provider not found" };
      }

      return result;
    }
  );

  /**
   * 揭示已存 API key 明文。刻意做成独立端点、只在前端点"眼睛"时调用 ——
   * 列表/详情响应仍只带 hasApiKey,明文不随常规数据流离开服务端(坑 2 的收窄版:
   * 从"永不离开"收窄为"仅经这个显式端点单次返回")。
   */
  app.get(
    "/api/v1/providers/:id/api-key",
    async (request, reply): Promise<{ apiKey: string } | { error: string }> => {
      const { id } = request.params as { id: string };
      const apiKey = app.api.providers.revealApiKey(id);

      if (apiKey === undefined) {
        reply.code(404);
        return { error: "Provider not found" };
      }

      return { apiKey };
    }
  );

  app.get(
    "/api/v1/providers/:id/models",
    async (request, reply): Promise<ProviderModelsPayload | { error: string }> => {
      const { id } = request.params as { id: string };
      const models = app.api.providers.listModels(id);

      if (!models) {
        reply.code(404);
        return { error: "Provider not found" };
      }

      return models;
    }
  );

  app.post(
    "/api/v1/providers/:id/models/fetch",
    async (request, reply): Promise<ProviderModelsPayload | { error: string }> => {
      const { id } = request.params as { id: string };
      const body = providerRuntimeOverrideSchema.parse(request.body ?? {});

      try {
        const discovered = await app.api.providers.discoverModels(id, {
          ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
          ...(body.baseURL !== undefined ? { baseURL: body.baseURL } : {})
        });

        if (!discovered) {
          reply.code(404);
          return { error: "Provider not found" };
        }

        return discovered;
      } catch (error) {
        // 上游 HTTP 故障 → 502/400。这条映射是协议翻译,留在 route。
        if (error instanceof ProviderHttpError) {
          reply.code(error.statusCode >= 500 ? 502 : 400);
          return { error: error.message };
        }
        throw error;
      }
    }
  );

  app.put(
    "/api/v1/providers/:id/models",
    async (request, reply): Promise<Provider | { error: string }> => {
      const { id } = request.params as { id: string };
      const body = updateProviderModelsSchema.parse(request.body ?? {});
      const input: ProviderUpdateInput = { models: normalizeProviderModels(body.models) };
      const updated = app.api.providers.update(id, input);
      if (!updated) {
        reply.code(404);
        return { error: "Provider not found" };
      }
      return updated;
    }
  );

  app.put("/api/v1/providers/:id", async (request, reply): Promise<Provider | { error: string }> => {
    const { id } = request.params as { id: string };
    const body = updateProviderSchema.parse(request.body ?? {});
    const input: ProviderUpdateInput = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.type !== undefined ? { type: body.type as ProviderType } : {}),
      ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
      ...(body.clearApiKey !== undefined ? { clearApiKey: body.clearApiKey } : {}),
      ...(body.baseURL !== undefined ? { baseURL: body.baseURL } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.models !== undefined ? { models: normalizeProviderModels(body.models) } : {}),
      ...(body.availableModels !== undefined
        ? { availableModels: normalizeProviderModels(body.availableModels) }
        : {})
    };
    const updated = app.api.providers.update(id, input);
    if (!updated) {
      reply.code(404);
      return { error: "Provider not found" };
    }
    return updated;
  });

  app.delete("/api/v1/providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.api.providers.delete(id)) {
      reply.code(404);
      return { error: "Provider not found" };
    }
    reply.code(204);
    return null;
  });
};