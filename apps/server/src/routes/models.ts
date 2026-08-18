import type { FastifyInstance } from "fastify";
import type { ModelSummary } from "@eva/shared";

import { listProviders } from "../services/providers/provider-repository.js";
import { qualifyProviderModelId } from "../services/settings/model-id.js";

/** 所有 enabled provider 的模型目录,产出 qualified id(供 UI 选择器)。 */
export const registerModelRoutes = (app: FastifyInstance): void => {
  app.get("/api/v1/models", async (): Promise<readonly ModelSummary[]> => {
    const providers = listProviders(app.infra.db).filter((p) => p.enabled);

    return providers.flatMap((provider) =>
      provider.models.map((model) => ({
        id: qualifyProviderModelId(provider.id, model.id),
        name: model.name,
        provider: provider.name,
        providerId: provider.id,
        ...(model.capabilities !== undefined ? { capabilities: model.capabilities } : {})
      }))
    );
  });
};