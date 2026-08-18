import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import type { AgentModel, AgentModelFactory } from "./agent-model.js";

// OpenAI 兼容协议的 provider 工厂(openai/deepseek/openrouter/moonshot/custom 等)。
// 返回 LanguageModel,供 streamText 使用。
export const createOpenAiCompatibleModel: AgentModelFactory = (options): AgentModel => {
  const provider = createOpenAICompatible({
    name: "openai-compatible",
    baseURL: options.baseURL ?? "",
    apiKey: options.apiKey
  });

  return provider(options.model);
};