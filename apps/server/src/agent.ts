import type { LanguageModel } from "ai";
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
  type AgentTool,
  type PromptSection,
  type RequestApproval,
  type Skill
} from "@eva/harness";

import { toolOverflowDir } from "./paths.js";
import type { ModelBinding } from "./services/providers/model-resolver.js";

export class AgentUnavailableError extends Error {
  constructor(
    message = "Agent is not configured. Configure an enabled provider and default model in Settings."
  ) {
    super(message);
  }
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
  /** 进程级注册的外部工具（当前来源：MCP registry）。 */
  readonly extraTools?: readonly AgentTool[] | undefined;
  /** 本次 run 的工作区;缺省则不注入 fs 工具(纯聊天会话)。 */
  readonly workspace?: ResolvedWorkspaceContext | undefined;
}

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

/** 按 binding.kind 分派到对应的 AI SDK 工厂。 */
export const toAgentModel = (binding: ModelBinding): LanguageModel => {
  const options = {
    apiKey: binding.apiKey,
    ...(binding.baseURL ? { baseURL: binding.baseURL } : {}),
    model: binding.modelId
  };

  return binding.kind === "anthropic"
    ? createAnthropicModel(options)
    : createOpenAiCompatibleModel(options);
};

export const createConfiguredAgent = (
  options: ConfiguredAgentOptions,
  models: { readonly chat: ModelBinding; readonly tool: ModelBinding; readonly temperature: number },
  getModel: (binding: ModelBinding) => LanguageModel
): Agent => {
  const { skills, soulSection, observer, workspace, requestApproval, extraTools } = options;

  const tools = [
    ...(skills.length > 0 ? [createReadSkillTool(skills)] : []),
    createDuckDuckGoWebSearchTool(),
    createWebFetchTool({ summaryModel: getModel(models.tool) }),
    ...(extraTools ?? [])
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
    createWebSearchPromptSection(),
    createWebFetchPromptSection()
  ];

  return createAgent({
    model: getModel(models.chat),
    tools,
    systemPrompt: buildAgentSystemPrompt({ sections }),
    maxSteps: 25,
    callSettings: {
      temperature: models.temperature,
      ...(models.chat.maxOutputTokens !== undefined
        ? { maxOutputTokens: models.chat.maxOutputTokens }
        : {})
    },
    ...(requestApproval !== undefined ? { requestApproval } : {}),
    contextPolicy: {
      ...(models.chat.contextWindow !== undefined
        ? { contextWindow: models.chat.contextWindow }
        : {}),
      ...(models.chat.maxOutputTokens !== undefined
        ? { reservedOutputTokens: models.chat.maxOutputTokens }
        : {})
    },
    ...(observer !== undefined ? { observer } : {})
  });
};