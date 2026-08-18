import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import type { AgentModel, AgentModelFactory } from "./agent-model.js";

// OpenAI 兼容协议的 provider 工厂(openai/deepseek/openrouter/moonshot/custom 等)。
// 返回 LanguageModel,供 streamText 使用。
export interface OpenAiCompatibleConfiguration {
  baseURL?: string;
}

export interface OpenAiCompatibleModelOptions {
  apiKey: string;
  configuration?: OpenAiCompatibleConfiguration;
  model: string;
  /** 已不生效:temperature 是 AI SDK 的 call setting,走 AgentCallSettings 透传。T4 清理该字段。 */
  temperature?: number;
}

export const createOpenAiCompatibleModel: AgentModelFactory = (options): AgentModel => {
  const provider = createOpenAICompatible({
    name: "openai-compatible",
    baseURL: options.baseURL ?? "",
    apiKey: options.apiKey
  });

  return provider(options.model);
};
