import type { ProviderType } from "@eva/shared";
import {
  buildAgentSystemPrompt,
  createAgent,
  createDuckDuckGoWebSearchTool,
  createReadSkillTool,
  createWebFetchPromptSection,
  createWebFetchTool,
  createWebSearchPromptSection,
  generalPurposeSubagent,
  OpenAiCompatibleModel,
  skillsToPromptSection,
  type Agent,
  type AgentObserver,
  type PromptSection,
  type Skill
} from "@eva/harness";

import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db/index.js";
import {
  findStoredProviderById,
  loadAppSettings,
  qualifyModelId,
  splitQualifiedModelId,
  type StoredProviderConfig
} from "./services/settings-store.js";

const DEFAULT_OPENAI_COMPATIBLE_BASE_URLS: Partial<Record<ProviderType, string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  moonshot: "https://api.moonshot.cn/v1"
};

const OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES = new Set<ProviderType>([
  "openai",
  "aihubmix",
  "openrouter",
  "deepseek",
  "copilot",
  "moonshot",
  "custom",
  "acp",
  "claude-subscription",
  "zai-coding-plan",
  "kimi-coding-plan"
]);

const toNonEmptyString = (value?: string): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const ensureQualifiedModelId = (
  value: string | undefined,
  fallbackProviderId: string
): string | undefined => {
  const normalized = value?.trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.includes(":")) {
    return normalized;
  }

  return `${fallbackProviderId}:${normalized}`;
};

export class AgentUnavailableError extends Error {
  constructor(
    message = "Agent is not configured. Configure an enabled OpenAI-compatible provider and default model in Settings."
  ) {
    super(message);
  }
}

export interface BuildAgentOptions {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly skills: Skill[];
  readonly soulSection?: PromptSection | undefined;
  readonly observer?: AgentObserver | undefined;
  readonly requestedModelId?: string | undefined;
}

export interface AgentResolverInput {
  readonly modelId?: string;
}

export type AgentResolver = (input?: AgentResolverInput) => Agent;

export interface ResolvedRuntimeModelBinding {
  readonly providerId: string;
  readonly providerType: ProviderType;
  readonly qualifiedModelId: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly temperature: number;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export type AgentRuntimeResolution =
  | {
    ok: true;
    value: {
      readonly mainModel: ResolvedRuntimeModelBinding;
      readonly toolModel?: ResolvedRuntimeModelBinding;
    };
  }
  | {
    ok: false;
    reason: string;
  };

const resolveModelBinding = (
  provider: StoredProviderConfig | undefined,
  qualifiedModelId: string,
  modelId: string,
  temperature: number
): ResolvedRuntimeModelBinding | undefined => {
  if (!provider) {
    return undefined;
  }

  if (!OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES.has(provider.type)) {
    return undefined;
  }

  if (!provider.enabled) {
    return undefined;
  }

  const apiKey = toNonEmptyString(provider.apiKey);

  if (!apiKey) {
    return undefined;
  }

  const baseURL = toNonEmptyString(provider.baseURL)
    ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URLS[provider.type];

  if (!baseURL && provider.type !== "openai") {
    return undefined;
  }

  const modelCapabilities = provider.models.find((model) => model.id === modelId)?.capabilities
    ?? provider.availableModels.find((model) => model.id === modelId)?.capabilities;

  return {
    providerId: provider.id,
    providerType: provider.type,
    qualifiedModelId,
    modelId,
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    temperature,
    ...(modelCapabilities?.contextWindow !== undefined
      ? { contextWindow: modelCapabilities.contextWindow }
      : {}),
    ...(modelCapabilities?.maxOutputTokens !== undefined
      ? { maxOutputTokens: modelCapabilities.maxOutputTokens }
      : {})
  };
};

const toAgentModel = (binding: ResolvedRuntimeModelBinding): OpenAiCompatibleModel =>
  new OpenAiCompatibleModel({
    apiKey: binding.apiKey,
    ...(binding.baseURL ? { configuration: { baseURL: binding.baseURL } } : {}),
    model: binding.modelId,
    temperature: binding.temperature
  });

const createConfiguredAgent = (
  options: Omit<BuildAgentOptions, "requestedModelId" | "db">,
  runtime: AgentRuntimeResolution & { ok: true }
): Agent => {
  const {
    skills,
    soulSection,
    observer
  } = options;
  const { mainModel, toolModel } = runtime.value;

  const tools = [
    ...(skills.length > 0 ? [createReadSkillTool(skills)] : []),
    createDuckDuckGoWebSearchTool()
  ];

  const sections: PromptSection[] = [
    ...(soulSection ? [soulSection] : []),
    {
      heading: "Memory",
      body: [
        "- Relevant memories are automatically recalled and provided in your context each turn",
        "- Use `search_memory` when you need to find specific memories not in the current context, or when the user explicitly asks to search past memory",
        "- Use `save_memory` to store important new facts. ALWAYS call `search_memory` first to check for duplicates before saving",
        "- Update an existing memory (via updateId) when the underlying fact has changed",
        "- Never claim that you will remember something later unless you actually called `save_memory` in this turn",
        "- Assign the correct category: user (personal info), preference (habits/style), project (project facts), decision (decisions made), knowledge (general facts)"
      ].join("\n")
    },
    ...(skills.length > 0 ? [skillsToPromptSection(skills)] : []),
    createWebSearchPromptSection()
  ];

  if (toolModel) {
    tools.push(createWebFetchTool({ summaryModel: toAgentModel(toolModel) }));
    sections.push(createWebFetchPromptSection());
  }

  return createAgent({
    model: toAgentModel(mainModel),
    tools,
    systemPrompt: buildAgentSystemPrompt({ sections }),
    maxSteps: 25,
    contextPolicy: {
      ...(mainModel.contextWindow !== undefined
        ? { contextWindow: mainModel.contextWindow }
        : {}),
      ...(mainModel.maxOutputTokens !== undefined
        ? { reservedOutputTokens: mainModel.maxOutputTokens }
        : {})
    },
    subagents: [generalPurposeSubagent],
    ...(observer !== undefined ? { observer } : {})
  });
};

export const resolveAgentRuntimeConfig = ({
  config,
  db,
  requestedModelId
}: Pick<BuildAgentOptions, "config" | "db" | "requestedModelId">): AgentRuntimeResolution => {
  const settings = loadAppSettings(db, config);
  const selectedModelId = qualifyModelId(requestedModelId?.trim() ?? "", "openai")
    || settings.chat.defaultModel;
  const parsedMainModel = splitQualifiedModelId(selectedModelId);

  if (!parsedMainModel) {
    return {
      ok: false,
      reason: "No default model is configured."
    };
  }

  const mainProvider = findStoredProviderById(db, parsedMainModel.providerId);

  if (!mainProvider) {
    return {
      ok: false,
      reason: `Provider "${parsedMainModel.providerId}" was not found.`
    };
  }

  if (!OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES.has(mainProvider.type)) {
    return {
      ok: false,
      reason: `Provider type "${mainProvider.type}" is not supported for chat runtime yet.`
    };
  }

  const mainModel = resolveModelBinding(
    mainProvider,
    selectedModelId,
    parsedMainModel.modelId,
    settings.chat.temperature
  );

  if (!mainModel) {
    return {
      ok: false,
      reason: `Provider "${mainProvider.name}" is not ready. Enable it and configure a valid API key first.`
    };
  }

  const configuredToolModelId = toNonEmptyString(settings.toolModel.model)
    ?? toNonEmptyString(config.WEB_FETCH_MODEL);
  const qualifiedToolModelId = ensureQualifiedModelId(
    configuredToolModelId,
    mainModel.providerId
  );
  const parsedToolModel = qualifiedToolModelId
    ? splitQualifiedModelId(qualifiedToolModelId)
    : undefined;
  const toolProvider = parsedToolModel
    ? findStoredProviderById(db, parsedToolModel.providerId)
    : undefined;
  const toolModel = parsedToolModel
    ? resolveModelBinding(
      toolProvider,
      qualifiedToolModelId!,
      parsedToolModel.modelId,
      0.1
    )
    : undefined;

  return {
    ok: true,
    value: {
      mainModel,
      ...(toolModel ? { toolModel } : {})
    }
  };
};

export const buildAgent = (options: BuildAgentOptions): Agent | undefined => {
  const runtime = resolveAgentRuntimeConfig(options);

  if (!runtime.ok) {
    return undefined;
  }

  return createConfiguredAgent(options, runtime);
};

export const createAgentResolver = (
  options: Omit<BuildAgentOptions, "requestedModelId">
): AgentResolver =>
  (input) => {
    const runtime = resolveAgentRuntimeConfig({
      config: options.config,
      db: options.db,
      requestedModelId: input?.modelId
    });

    if (!runtime.ok) {
      throw new AgentUnavailableError(runtime.reason);
    }

    return createConfiguredAgent(options, runtime);
  };
