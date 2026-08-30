import type { LanguageModel } from "ai";
import {
  createAnthropicModel,
  createOpenAiCompatibleModel,
} from "@eva/harness";

import type { ModelBinding } from "./model-resolver.js";

/** Convert a resolved provider binding into the matching AI SDK model. */
export const toAgentModel = (binding: ModelBinding): LanguageModel => {
  const options = {
    apiKey: binding.apiKey,
    ...(binding.baseURL ? { baseURL: binding.baseURL } : {}),
    model: binding.modelId,
  };

  return binding.kind === "anthropic"
    ? createAnthropicModel(options)
    : createOpenAiCompatibleModel(options);
};
