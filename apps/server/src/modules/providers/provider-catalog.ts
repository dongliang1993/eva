import type { ProviderModel, ProviderSpec } from "@eva/shared";

/** provider 能力目录是「支持哪些 provider」的单一事实源。加 provider 时先想清楚它属于哪种 kind。 */

const OPENAI_BUILTIN_MODELS: readonly ProviderModel[] = [
  {
    id: "gpt-4.1",
    name: "gpt-4.1",
    capabilities: { contextWindow: 1_000_000, functionCalling: true, streaming: true }
  },
  {
    id: "gpt-4.1-mini",
    name: "gpt-4.1-mini",
    capabilities: { contextWindow: 1_000_000, functionCalling: true, streaming: true }
  },
  {
    id: "gpt-4o",
    name: "gpt-4o",
    capabilities: { contextWindow: 128_000, functionCalling: true, streaming: true, vision: true }
  },
  {
    id: "o3",
    name: "o3",
    capabilities: { contextWindow: 200_000, functionCalling: true, streaming: true, reasoning: true }
  }
];

const ANTHROPIC_BUILTIN_MODELS: readonly ProviderModel[] = [
  {
    id: "claude-opus-4-6",
    name: "claude-opus-4-6",
    capabilities: { contextWindow: 200_000, functionCalling: true, streaming: true, vision: true }
  },
  {
    id: "claude-sonnet-4-6",
    name: "claude-sonnet-4-6",
    capabilities: { contextWindow: 200_000, functionCalling: true, streaming: true, vision: true }
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "claude-haiku-4-5-20251001",
    capabilities: { contextWindow: 200_000, functionCalling: true, streaming: true }
  }
];

export const PROVIDER_CATALOG: readonly ProviderSpec[] = [
  {
    type: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    defaultBaseURL: "https://api.openai.com/v1",
    apiKeyHint: "sk-...",
    builtinModels: OPENAI_BUILTIN_MODELS
  },
  {
    type: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    apiKeyHint: "sk-ant-...",
    builtinModels: ANTHROPIC_BUILTIN_MODELS
  },
  {
    type: "deepseek",
    label: "DeepSeek",
    kind: "openai-compatible",
    defaultBaseURL: "https://api.deepseek.com/v1",
    builtinModels: []
  },
  {
    type: "openrouter",
    label: "OpenRouter",
    kind: "openai-compatible",
    defaultBaseURL: "https://openrouter.ai/api/v1",
    builtinModels: []
  },
  {
    type: "moonshot",
    label: "Moonshot",
    kind: "openai-compatible",
    defaultBaseURL: "https://api.moonshot.cn/v1",
    builtinModels: []
  },
  {
    type: "aihubmix",
    label: "AiHubMix",
    kind: "openai-compatible",
    defaultBaseURL: "https://aihubmix.com/v1",
    builtinModels: []
  },
  {
    type: "custom",
    label: "自定义（OpenAI 兼容）",
    kind: "openai-compatible",
    baseURLPlaceholder: "https://your-endpoint/v1",
    builtinModels: []
  }
];

/** 未知 type(历史数据)返回 undefined —— 调用方按"不可用"处理,不要猜。 */
export const findProviderSpec = (type: string): ProviderSpec | undefined =>
  PROVIDER_CATALOG.find((spec) => spec.type === type);

/** provider 是否具备发起调用的最低条件(有 key,且 baseURL 可解析)。 */
export const resolveProviderBaseURL = (
  spec: ProviderSpec,
  configured: string | undefined
): string | undefined => configured?.trim() || spec.defaultBaseURL;
