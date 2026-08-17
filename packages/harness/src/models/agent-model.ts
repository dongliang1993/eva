import type { LanguageModel } from "ai";

// 迁移到 Vercel AI SDK:AgentModel 不再是自定义接口,直接用 LanguageModel。
// LeadAgent 用 streamText({ model, ... }) 调用,不再 model.invoke/stream。
// 保留一个工厂类型,封装 provider 选择 + 多模型槽(mainModel/toolModel)。
export type AgentModel = LanguageModel;

export interface AgentModelOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature?: number;
}

// 工厂:根据 provider 类型构造 LanguageModel。具体实现见 anthropic.ts /
// openai-compatible.ts。server/agent.ts 的 toAgentModel 调它。
export type AgentModelFactory = (options: AgentModelOptions) => AgentModel;
