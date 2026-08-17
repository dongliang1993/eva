import { createAnthropic } from "@ai-sdk/anthropic";

import type { AgentModel, AgentModelFactory } from "./agent-model.js";

// Anthropic Claude provider 工厂。返回 LanguageModel,供 streamText 使用。
// baseURL 留空时走官方 api.anthropic.com;填 baseURL 可走代理/自托管。
export interface AnthropicModelOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature?: number;
}

export const createAnthropicModel: AgentModelFactory = (options): AgentModel => {
  const provider = createAnthropic({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {})
  });

  return provider(options.model);
};
