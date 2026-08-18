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

import {
  createProvider,
  deleteProvider,
  findProviderById,
  findStoredProviderById,
  listProviders,
  updateProvider,
  type ProviderCreateInput,
  type ProviderUpdateInput
} from "../services/providers/provider-repository.js";
import {
  ProviderHttpError,
  discoverProviderModels,
  listProviderModels,
  testProviderConnection
} from "../services/providers/provider-http.js";
import { PROVIDER_CATALOG } from "../services/providers/provider-catalog.js";

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
    listProviders(app.infra.db)
  );

  // provider 静态知识(不含密钥),frontend 用 staleTime=Infinity 缓存。
  app.get("/api/v1/provider-catalog", async (): Promise<readonly ProviderSpec[]> =>
    PROVIDER_CATALOG
  );

  app.post("/api/v1/providers", async (request, reply): Promise<Provider | { error: string }> => {
    const body = createProviderSchema.parse(request.body ?? {});
    const existing = body.id ? findProviderById(app.infra.db, body.id) : undefined;

    if (existing) {
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
    const created = createProvider(app.infra.db, input);
    app.services.agents.invalidate();
    return created;
  });

  app.post(
    "/api/v1/providers/:id/test",
    async (request, reply): Promise<ProviderConnectionTestResult | { error: string }> => {
      const { id } = request.params as { id: string };
      const provider = findStoredProviderById(app.infra.db, id);
      if (!provider) {
        reply.code(404);
        return { error: "Provider not found" };
      }
      const body = providerRuntimeOverrideSchema.parse(request.body ?? {});
      return testProviderConnection(provider, {
        ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
        ...(body.baseURL !== undefined ? { baseURL: body.baseURL } : {})
      });
    }
  );

  app.get(
    "/api/v1/providers/:id/models",
    async (request, reply): Promise<ProviderModelsPayload | { error: string }> => {
      const { id } = request.params as { id: string };
      const provider = findStoredProviderById(app.infra.db, id);
      if (!provider) {
        reply.code(404);
        return { error: "Provider not found" };
      }
      return listProviderModels(provider);
    }
  );

  app.post(
    "/api/v1/providers/:id/models/fetch",
    async (request, reply): Promise<ProviderModelsPayload | { error: string }> => {
      const { id } = request.params as { id: string };
      const provider = findStoredProviderById(app.infra.db, id);
      if (!provider) {
        reply.code(404);
        return { error: "Provider not found" };
      }
      const body = providerRuntimeOverrideSchema.parse(request.body ?? {});

      try {
        const discovered = await discoverProviderModels(provider, {
          ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
          ...(body.baseURL !== undefined ? { baseURL: body.baseURL } : {})
        });
        updateProvider(app.infra.db, id, { availableModels: discovered.models });
        app.services.agents.invalidate();
        return discovered;
      } catch (error) {
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
      const updated = updateProvider(app.infra.db, id, input);
      if (!updated) {
        reply.code(404);
        return { error: "Provider not found" };
      }
      app.services.agents.invalidate();
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
    const updated = updateProvider(app.infra.db, id, input);
    if (!updated) {
      reply.code(404);
      return { error: "Provider not found" };
    }
    app.services.agents.invalidate();
    return updated;
  });

  app.delete("/api/v1/providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = deleteProvider(app.infra.db, id);
    if (!deleted) {
      reply.code(404);
      return { error: "Provider not found" };
    }
    app.services.agents.invalidate();
    reply.code(204);
    return null;
  });
};