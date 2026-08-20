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
  filterToolsForRole,
  missingRoleTools,
  skillsToPromptSection,
  SUBAGENT_MAX_STEPS,
  type Agent,
  type AgentObserver,
  type AgentTool,
  type PromptSection,
  type RequestApproval,
  type Skill
} from "@eva/harness";

import { toolOverflowDir } from "../paths.js";
import type { AppInfrastructure } from "../types/common.js";
import {
  resolveModelSlot,
  type ModelBinding
} from "./providers/model-resolver.js";
import { loadAppSettings } from "./settings/app-settings.js";

export class AgentUnavailableError extends Error {
  constructor(
    message = "Agent is not configured. Configure an enabled provider and default model in Settings."
  ) {
    super(message);
  }
}

/** 一次 run 的工作区上下文 —— 路径 + 已读好的项目文档 section。 */
export interface WorkspaceContext {
  readonly id: string;
  readonly root: string;
  readonly docsSection?: PromptSection | undefined;
}

export interface AgentBuildOptions {
  /** 本轮选定的模型("providerId:modelId")。必填 —— 没有全局默认,没模型就不该装 agent。 */
  readonly modelId: string;
  readonly requestApproval?: RequestApproval | undefined;
  readonly workspace?: WorkspaceContext | undefined;
  /** 进程级外部工具（MCP）；由路由从 registry 取好传进来。 */
  readonly extraTools?: readonly AgentTool[] | undefined;
  /** per-run 读好的人类可读记忆 section（L1 MEMORY.md + 近几天日记）。 */
  readonly memoryFilesSection?: PromptSection | undefined;
}

export interface ResolvedModels {
  readonly chat: ModelBinding;
  readonly tool: ModelBinding;
  readonly temperature: number;
}

export interface ResolvedAgent {
  readonly agent: Agent;
  readonly mainModel: ModelBinding;
  readonly toolModel: ModelBinding;
}

// Agent system prompt 的 Memory 板块,由 build 注入。
// T16 §2.4:五工具的分工是"规模与访问模式"切(L1 全量注入 vs L4 按需检索),不是按内容切。
// 判据必须给模型一句能直接照着判的话;别在 5 个工具 description 里各写一遍(会互相矛盾)。
const MEMORY_PROMPT_SECTION: PromptSection = {
  heading: "Memory",
  body: [
    "- Relevant memories are automatically recalled and provided in your context each turn",
    "- `MEMORY.md` and your recent daily notes are injected into your context this turn (see ## Memory Files). These are human-readable files the user can edit directly.",
    "",
    "Five tools, three places — pick by scale and access pattern:",
    "- Ask yourself: *is this fact worth spending tokens on every single turn?* Yes -> `update_long_term_memory` (MEMORY.md). No -> `save_memory` (database).",
    "- `update_long_term_memory`: stable identity, preferences, durable constraints. Read the WHOLE file first with `read_memory_file(\"MEMORY.md\")`, then write back the full content — it REPLACES the file.",
    "- `append_memory`: day-stamped decisions and ephemeral events, into today's daily note.",
    "- `save_memory` / `search_memory`: searchable facts and project knowledge in the database. ALWAYS `search_memory` before saving to avoid duplicates; pass updateId to update.",
    "- `read_memory_file` with no argument lists your memory files — use it to discover days beyond the injected window.",
    "- Never claim you will remember something unless you actually called one of these tools this turn."
  ].join("\n")
};

/**
 * LanguageModel 实例缓存键 —— 只包含决定"实例本身"的字段。
 * temperature/maxOutputTokens 是 call settings,不进键。
 */
const modelCacheKey = (b: ModelBinding): string =>
  [b.kind, b.providerId, b.baseURL ?? "", b.modelId, b.apiKey].join("|");

/**
 * exactOptionalPropertyTypes 下 `key?: T | undefined` 不许显式传 undefined,
 * 只能条件展开 —— 连续多个字段时 `...(x !== undefined ? {x} : {})` 太吵。
 * 这个 helper 就是那个展开的具名版:{...defined("workspace", w)}。
 */
export const defined = <K extends string, T>(key: K, value: T | undefined): { [P in K]: T } | Record<never, never> =>
  value !== undefined ? ({ [key]: value } as { [P in K]: T }) : {};

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

/**
 * 主 agent 与子代理共用的基础工具集(不含记忆/审批那层)。
 * 子代理按角色白名单 filter 这个结果,而不是重建一套 —— 角色能拿什么工具,
 * 只能从这批"进程里真实存在的工具"里选(阀4)。
 */
export const buildBaseTools = (
  options: {
    readonly skills: readonly Skill[];
    readonly workspace?: WorkspaceContext | undefined;
    readonly extraTools?: readonly AgentTool[] | undefined;
  },
  getToolModel: (binding: ModelBinding) => LanguageModel,
  toolBinding: ModelBinding
): AgentTool[] => {
  const { skills, workspace, extraTools } = options;

  const tools: AgentTool[] = [
    ...(skills.length > 0 ? [createReadSkillTool([...skills] as Skill[])] : []),
    createDuckDuckGoWebSearchTool(),
    createWebFetchTool({ summaryModel: getToolModel(toolBinding) }),
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

  return tools;
};

/**
 * per-run 装配 agent。
 *
 * 为什么不在装配期建单例:模型/温度/工作区都是 per-run 决策(用户在 UI 换模型、
 * per-workspace 工具集),单例把这些全钉死了。昂贵的只有 provider 实例构造,
 * 所以只缓存 LanguageModel。
 */
export class AgentFactory {
  private readonly models = new Map<string, LanguageModel>();

  constructor(private readonly infra: AppInfrastructure) { }

  /** provider / settings 变更后失效缓存(apiKey、baseURL 可能已改)。 */
  invalidate(): void {
    this.models.clear();
  }

  /** 只读暴露缓存大小,供测试与可观测使用。 */
  get modelCacheSize(): number {
    return this.models.size;
  }

  /** 解析所选模型 + tool 模型(缺省/不可用时 tool 回落 chat)。 */
  resolveModels(options: {
    /** 本轮选定的 chat 模型。必填 —— chat 槽位只认它,没给就是没有。 */
    modelId: string;
  }): ResolvedModels {
    const chat = resolveModelSlot(this.infra.db, this.infra.config, "chat", options.modelId);
    if (!chat.ok) {
      throw new AgentUnavailableError(chat.reason);
    }

    const tool = resolveModelSlot(this.infra.db, this.infra.config, "tool");

    return {
      chat: chat.binding,
      // tool 槽位没配或不可用 → 回落 chat(不是错误:杂务用主模型只是贵一点)
      tool: tool.ok ? tool.binding : chat.binding,
      // temperature 是 call setting,不是绑定属性 —— 从 settings 读一次。
      temperature: loadAppSettings(this.infra.db, this.infra.config).chat.temperature
    };
  }

  /**
   * 按本轮配置装一台主 agent。
   *
   * 为什么叫 build 不叫 resolve:resolve 只描述了"定模型"这一半,这个方法的
   * 主业是"用定好的模型 + 工作区 + 工具 + 记忆装一台能跑的 agent"。和
   * buildSubagent 对齐 —— 主代理/子代理都是 build,只是一个走全量配置一个走角色白名单。
   *
   * @throws AgentUnavailableError 当没有可用的 provider/模型配置时。
   */
  build(options: AgentBuildOptions): ResolvedAgent {
    const models = this.resolveModels({ modelId: options.modelId });

    const tools = buildBaseTools(
      {
        skills: this.infra.skills,
        ...defined("workspace", options.workspace),
        ...defined("extraTools", options.extraTools)
      },
      (binding) => this.getModel(binding),
      models.tool
    );

    // defined() 摊的是 {key: value} 对象,这里要的是数组元素 —— 条件展开回原样。
    const sections: PromptSection[] = [
      ...(this.infra.soulSection ? [this.infra.soulSection] : []),
      ...(options.workspace?.docsSection ? [options.workspace.docsSection] : []),
      ...(options.memoryFilesSection ? [options.memoryFilesSection] : []),
      MEMORY_PROMPT_SECTION,
      ...(this.infra.skills.length > 0 ? [skillsToPromptSection([...this.infra.skills])] : []),
      createWebSearchPromptSection(),
      createWebFetchPromptSection()
    ];

    const agent = createAgent({
      model: this.getModel(models.chat),
      tools,
      systemPrompt: buildAgentSystemPrompt({ sections }),
      maxSteps: 25,
      callSettings: {
        temperature: models.temperature,
        ...defined("maxOutputTokens", models.chat.maxOutputTokens)
      },
      ...defined("requestApproval", options.requestApproval),
      // T18:schema 不匹配时用 tool 槽位模型修一次 —— 结构化小生成正是该槽位的用途。
      repairModel: this.getModel(models.tool),
      contextPolicy: {
        ...defined("contextWindow", models.chat.contextWindow),
        ...defined("reservedOutputTokens", models.chat.maxOutputTokens)
      },
      ...defined("observer", this.infra.observer)
    });

    return {
      agent,
      mainModel: models.chat,
      toolModel: models.tool
    };
  }

  private getModel(binding: ModelBinding): LanguageModel {
    const key = modelCacheKey(binding);
    const cached = this.models.get(key);

    if (cached) return cached;

    const model = toAgentModel(binding);
    this.models.set(key, model);
    return model;
  }

  /**
   * 装配一个子代理(S7):工具槽模型 + 角色白名单工具 + 角色 system prompt。
   *
   * 阀1(便宜):子代理用 tool 槽位模型,不走 chat。
   * 阀4(收窄):只在 buildBaseTools 的基础集上按角色的 allowedTools 过滤 ——
   *   角色能拿到的永远是进程里真实存在的工具,白名单只是让写工具/执行工具缺席。
   *   一个 fork 是全新装配(不是复用主 agent),所以深度/委托闸在 Task 里判。
   * @throws AgentUnavailableError 没配好 provider 时(与主 agent 同一路径)。
   */
  buildSubagent(options: {
    readonly role: import("@eva/harness").SubagentRole;
    readonly workspace?: WorkspaceContext | undefined;
    readonly extraTools?: readonly AgentTool[] | undefined;
    readonly temperature?: number | undefined;
    /**
     * 子代理的审批闸(T17)。注入后危险工具照包 withApproval ——
     * 只是闭包第一格是"自动通过并落台账"(docs 04 §8.6.1 分支 2)。
     * 不传 = 危险工具裸奔,那是 R4 的遗留状态,不是设计。
     */
    readonly requestApproval?: RequestApproval | undefined;
    /**
     * 本轮主链选定的 chat 模型("providerId:modelId")。必填 ——
     * 子代理的 tool 槽位回落 chat 时需要它,没有全局 chat 默认兜底,
     * 所以子代理必须沿用本轮主链的模型,不能自己另开一条解析路径。
     */
    readonly modelId: string;
  }): Agent {
    const models = this.resolveModels({ modelId: options.modelId });
    const baseTools = buildBaseTools(
      {
        skills: this.infra.skills,
        ...defined("workspace", options.workspace),
        ...defined("extraTools", options.extraTools)
      },
      (binding) => this.getModel(binding),
      models.tool
    );

    // 角色要的工具在这个会话里压根不存在 → 早爆,不给残废工具集。
    // (文件工具挂在工作区守卫内:没绑工作区时 explorer 只剩 read_skill,
    //  那样的子代理"没有手却被要求读代码",实测会编造目录树。)
    const missing = missingRoleTools(baseTools, options.role);
    if (missing.length > 0) {
      throw new AgentUnavailableError(
        `子代理 ${options.role.type} 缺少必需工具:${missing.join("、")}。` +
        "这些是工作区工具 —— 请先给该会话绑定一个工作区,再派子代理。"
      );
    }

    const tools = [...filterToolsForRole(baseTools, options.role)];

    return createAgent({
      model: this.getModel(models.tool),
      tools,
      systemPrompt: options.role.systemPrompt,
      maxSteps: options.role.maxSteps ?? SUBAGENT_MAX_STEPS,
      callSettings: {
        ...defined("temperature", options.temperature)
      },
      ...defined("requestApproval", options.requestApproval),
      // 子代理用的本来就是 tool 槽位(往往更弱),弱模型更需要修复器。
      repairModel: this.getModel(models.tool),
      ...defined("observer", this.infra.observer)
    });
  }
}
