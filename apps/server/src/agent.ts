import type { LanguageModel } from "ai";
import type { ProviderType } from "@eva/shared";
import {
  buildAgentSystemPrompt,
  createAgent,
  createAnthropicModel,
  createBashTool,
  createDuckDuckGoWebSearchTool,
  createEditTool,
  createGrepTool,
  createListDirTool,
  createOpenAiCompatibleModel,
  createReadFileTool,
  createReadSkillTool,
  createWebFetchPromptSection,
  createWebFetchTool,
  createWebSearchPromptSection,
  createWriteTool,
  skillsToPromptSection,
  type Agent,
  type AgentObserver,
  type PromptSection,
  type RequestApproval,
  type Skill
} from "@eva/harness";

import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db/index.js";
import { toolOverflowDir } from "./paths.js";
import {
  findStoredProviderById,
  loadAppSettings,
  qualifyModelId,
  splitQualifiedModelId,
  type StoredProviderConfig
} from "./services/settings-store.js";

const DEFAULT_OPENAI_COMPATIBLE_BASE_URLS: Partial<Record<ProviderType, string>> = {
  openai: "https://api.openai.com/v1"
};

// 只保留最基础的 provider:openai(OpenAI 兼容协议)+ anthropic(原生 SDK)。
// 与 settings-store.ts 的 CHAT_RUNTIME_PROVIDER_TYPES 保持同步。
const OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES = new Set<ProviderType>([
  "openai"
]);

const ANTHROPIC_AGENT_PROVIDER_TYPES = new Set<ProviderType>([
  "anthropic"
]);

const isSupportedAgentProviderType = (type: ProviderType): boolean =>
  OPENAI_COMPATIBLE_AGENT_PROVIDER_TYPES.has(type)
  || ANTHROPIC_AGENT_PROVIDER_TYPES.has(type);

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

/** 解析运行时模型绑定需要的输入(纯读 DB/config)。 */
export interface ResolveRuntimeOptions {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly requestedModelId?: string | undefined;
}

/** 一次 run 的工作区上下文 —— 路径 + 已读好的项目文档 section。 */
export interface ResolvedWorkspaceContext {
  readonly id: string;
  readonly root: string;
  readonly docsSection?: PromptSection | undefined;
}

/** 构造 agent 需要的输入(不含 db —— 模型已解析完)。 */
export interface ConfiguredAgentOptions {
  readonly skills: Skill[];
  readonly soulSection?: PromptSection | undefined;
  readonly observer?: AgentObserver | undefined;
  readonly requestApproval?: RequestApproval | undefined;
  /** 本次 run 的工作区;缺省则不注入 fs 工具(纯聊天会话)。 */
  readonly workspace?: ResolvedWorkspaceContext | undefined;
}

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

// Agent system prompt 的 Memory 板块说明,由 createConfiguredAgent 注入。
const MEMORY_PROMPT_SECTION: PromptSection = {
  heading: "Memory",
  body: [
    "- Relevant memories are automatically recalled and provided in your context each turn",
    "- Use `search_memory` when you need to find specific memories not in the current context, or when the user explicitly asks to search past memory",
    "- Use `save_memory` to store important new facts. ALWAYS call `search_memory` first to check for duplicates before saving",
    "- Update an existing memory (via updateId) when the underlying fact has changed",
    "- Never claim that you will remember something later unless you actually called `save_memory` in this turn",
    "- Assign the correct category: user (personal info), preference (habits/style), project (project facts), decision (decisions made), knowledge (general facts)"
  ].join("\n")
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

  if (!isSupportedAgentProviderType(provider.type)) {
    return undefined;
  }

  if (!provider.enabled) {
    return undefined;
  }

  const apiKey = toNonEmptyString(provider.apiKey);

  if (!apiKey) {
    return undefined;
  }

  // defaultBaseURL 是 OpenAI 兼容 provider 用的(参数无 baseURL 时由 SDK 用默认端点)。
  // openai/anthropic 都能用各自 SDK 的默认端点;自定义的 OpenAI 兼容 provider
  // (custom/deepseek 等)必须显式给 baseURL。
  const baseURL = toNonEmptyString(provider.baseURL);

  if (
    !baseURL
    && !DEFAULT_OPENAI_COMPATIBLE_BASE_URLS[provider.type]
    && provider.type !== "anthropic"
  ) {
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

export const toAgentModel = (binding: ResolvedRuntimeModelBinding): LanguageModel => {
  const options = {
    apiKey: binding.apiKey,
    ...(binding.baseURL ? { baseURL: binding.baseURL } : {}),
    model: binding.modelId,
    temperature: binding.temperature
  };

  if (ANTHROPIC_AGENT_PROVIDER_TYPES.has(binding.providerType)) {
    return createAnthropicModel(options);
  }

  return createOpenAiCompatibleModel(options);
};

export const createConfiguredAgent = (
  options: ConfiguredAgentOptions,
  runtime: AgentRuntimeResolution & { ok: true },
  getModel: (binding: ResolvedRuntimeModelBinding) => LanguageModel
): Agent => {
  const { mainModel, toolModel } = runtime.value;
  const { skills, soulSection, observer, workspace, requestApproval } = options;

  const tools = [
    ...(skills.length > 0 ? [createReadSkillTool(skills)] : []),
    createDuckDuckGoWebSearchTool()
  ];

  // 绑定了工作区 → 注入文件系统工具。overflow 落在 ~/.eva/tool-overflow/<id>/,
  // 不进用户仓库;只读白名单只对 read_file 放开,让它能读回自己的溢出文件。
  if (workspace) {
    const overflowDir = toolOverflowDir(workspace.id);
    tools.push(
      createReadFileTool({ workRoot: workspace.root, overflowDir, readableRoots: [overflowDir] }),
      createListDirTool({ workRoot: workspace.root, overflowDir }),
      createGrepTool({ workRoot: workspace.root, overflowDir }),
      createWriteTool({ workRoot: workspace.root, overflowDir }),
      createEditTool({ workRoot: workspace.root, overflowDir }),
      createBashTool({ workRoot: workspace.root, overflowDir })
    );
  }

  const sections: PromptSection[] = [
    ...(soulSection ? [soulSection] : []),
    ...(workspace?.docsSection ? [workspace.docsSection] : []),
    MEMORY_PROMPT_SECTION,
    ...(skills.length > 0 ? [skillsToPromptSection(skills)] : []),
    createWebSearchPromptSection()
  ];

  if (toolModel) {
    tools.push(createWebFetchTool({ summaryModel: getModel(toolModel) }));
    sections.push(createWebFetchPromptSection());
  }

  return createAgent({
    model: getModel(mainModel),
    tools,
    systemPrompt: buildAgentSystemPrompt({ sections }),
    maxSteps: 25,
    callSettings: {
      temperature: mainModel.temperature,
      ...(mainModel.maxOutputTokens !== undefined
        ? { maxOutputTokens: mainModel.maxOutputTokens }
        : {})
    },
    ...(requestApproval !== undefined ? { requestApproval } : {}),
    contextPolicy: {
      ...(mainModel.contextWindow !== undefined
        ? { contextWindow: mainModel.contextWindow }
        : {}),
      ...(mainModel.maxOutputTokens !== undefined
        ? { reservedOutputTokens: mainModel.maxOutputTokens }
        : {})
    },
    ...(observer !== undefined ? { observer } : {})
  });
};

export const resolveAgentRuntimeConfig = ({
  config,
  db,
  requestedModelId
}: ResolveRuntimeOptions): AgentRuntimeResolution => {
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

  if (!isSupportedAgentProviderType(mainProvider.type)) {
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

  const configuredToolModelId = toNonEmptyString(settings.toolModel.model);
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
