import type { LanguageModel } from "ai";
import {
  buildAgentSystemPrompt,
  createBashTool,
  createDuckDuckGoWebSearchTool,
  createEditTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createGrepTool,
  createListDirTool,
  createReadFileTool,
  createReadSkillTool,
  createWebFetchPromptSection,
  createWebFetchTool,
  createWebSearchPromptSection,
  createWriteTool,
  skillsToPromptSection,
  type Options,
  type PipelineTool,
  type PlanGateState,
  type PlanGateStore,
  type PromptSection,
  type Skill,
} from "@eva/harness";

import { toolOverflowDir } from "../../paths.js";
import { subagentDefinitions } from "../subagents/index.js";
import type { AppInfrastructure } from "../../types/common.js";
import {
  resolveModelSlot,
  toAgentModel,
  type ModelBinding,
} from "../providers/index.js";
import { loadAppSettings } from "../settings/index.js";

/**
 * 主 agent 单轮步数上限。对齐 Alma(docs 04 §8.4.2 的 100 步 + 134 步真实会话实证)。
 * 上下文两道防线(R1 compact 三件套 + tool-overflow 治理)已经在,
 * 步数闸不该比上下文闸先响 —— 25 对"读一个模块再改三个文件"的日常任务都不够。
 */
export const MAIN_AGENT_MAX_STEPS = 100;

/**
 * plan mode 的每步提醒(文案逐字搬自 harness 的 plan-gate/reminder.ts)。
 * 走 dynamicInstructions:它不能活在 enter_plan_mode 的工具结果里 ——
 * 那条消息会被 tool-result budget / compact 折走,plan 路径就丢了。
 */
const planGateReminder = (
  snap: { readonly active: boolean; readonly planPath?: string },
): readonly string[] => {
  if (!snap.active || !snap.planPath) return [];
  return [
    `Plan mode is active. Plan file: ${snap.planPath}. ` +
    "Direct file writes are limited to this plan file; use write/edit only on it. " +
    "When the plan is ready, call exit_plan_mode for approval.",
  ];
};

/**
 * 工具超时默认值 —— harness 不设默认(最小使用者不该被强加隐形行为),
 * 由 server 注入。bash 自带 120s 兜底,给到 150s;其余工具 60s 足够把
 * 挂死的 fs/NFS 调用收口(SDK 把超时折成 AbortSignal 传给 execute,
 * 工具实现负责观察 signal 并协作退出)。
 */
const TOOL_TIMEOUT = {
  defaultMs: 60_000,
  byTool: { bash: 150_000 },
} as const;

export class AgentUnavailableError extends Error {
  constructor(
    message = "Agent is not configured. Configure an enabled provider and default model in Settings.",
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
  readonly canUseTool?: Options["canUseTool"];
  readonly workspace?: WorkspaceContext | undefined;
  /** 本轮已固定的附加能力(MCP、memory 等)。 */
  readonly extraTools?: readonly PipelineTool[] | undefined;
  /** per-run 读好的人类可读记忆 section(L1 MEMORY.md + 近几天日记)。 */
  readonly memoryFilesSection?: PromptSection | undefined;
  /** Deterministically retrieved cross-session facts for this request. */
  readonly retrievedMemorySection?: PromptSection | undefined;
  /** run-scoped plan gate(工具集 + 每步提醒)。仅在绑了 workspace 时由路由注入。 */
  readonly planGate?:
  | {
    readonly state: PlanGateState;
    readonly store: PlanGateStore;
  }
  | undefined;
}

// Agent system prompt 的 Memory 板块,由 build 注入。
// 五工具的分工是"规模与访问模式"切(L1 全量注入 vs L4 按需检索),不是按内容切。
// 判据必须给模型一句能直接照着判的话;别在 5 个工具 description 里各写一遍(会互相矛盾)。
const createMemoryPromptSection = (databaseEnabled: boolean): PromptSection => ({
  heading: "Memory",
  body: [
    "- `MEMORY.md` and your recent daily notes are injected into your context this turn (see ## Memory Files). These are human-readable files the user can edit directly.",
    "",
    "Choose the store by scale and access pattern:",
    `- Ask yourself: *is this fact worth spending tokens on every single turn?* Yes -> \`update_long_term_memory\` (MEMORY.md). ${databaseEnabled ? "No -> \`save_memory\` (searchable database)." : "The searchable database is disabled for this run."}`,
    '- `update_long_term_memory`: stable identity, preferences, durable constraints. Read the WHOLE file first with \`read_memory_file("MEMORY.md")\`, then write back the full content — it REPLACES the file.',
    "- `append_memory`: day-stamped decisions and ephemeral events, into today's daily note.",
    "- `save_memory` / `search_memory`: searchable facts and project knowledge in the database. ALWAYS `search_memory` before saving to avoid duplicates; pass updateId to update.",
    "- `read_memory_file` with no argument lists your memory files — use it to discover days beyond the injected window.",
    "- Never claim you will remember something unless you actually called one of these tools this turn.",
  ].join("\n"),
});

export interface ResolvedModels {
  readonly chat: ModelBinding;
  readonly tool: ModelBinding;
  readonly temperature: number;
}

export interface ModelResolution {
  /** query() 的 Options(主 agent 全量)。 */
  readonly options: Options;
  readonly mainModel: ModelBinding;
  readonly toolModel: ModelBinding;
  readonly callSettings: { readonly temperature?: number; readonly maxOutputTokens?: number };
}

/** 主 agent 与子代理共用的基础工具集(不含记忆/审批那层)。 */
export const buildBaseTools = (
  options: {
    readonly skills: readonly Skill[];
    readonly workspace?: WorkspaceContext | undefined;
    readonly extraTools?: readonly PipelineTool[] | undefined;
    readonly planGate?:
    | {
      readonly state: PlanGateState;
      readonly store: PlanGateStore;
    }
    | undefined;
  },
): PipelineTool[] => {
  const { skills, workspace, extraTools, planGate } = options;

  const tools: PipelineTool[] = [
    ...(skills.length > 0 ? [createReadSkillTool([...skills] as Skill[])] : []),
    createDuckDuckGoWebSearchTool(),
    createWebFetchTool(),
    ...(extraTools ?? []),
  ];

  // 绑定了工作区 → 注入文件系统工具。overflow 落在 ~/.eva/tool-overflow/<id>/,
  // 不进用户仓库;只读白名单只对 read_file 放开,让它能读回自己的溢出文件。
  if (workspace) {
    const overflowDir = toolOverflowDir(workspace.id);
    tools.push(
      createReadFileTool({
        workRoot: workspace.root,
        overflowDir,
        readableRoots: [overflowDir],
      }),
      createListDirTool({ workRoot: workspace.root, overflowDir }),
      createGrepTool({ workRoot: workspace.root, overflowDir }),
      createWriteTool({ workRoot: workspace.root, overflowDir }),
      createEditTool({ workRoot: workspace.root, overflowDir }),
      createBashTool({ workRoot: workspace.root, overflowDir }),
    );

    // plan 工具与 fs 工具同一个注入条件 —— 无 workspace 就没有 plan gate。
    if (planGate) {
      tools.push(
        createEnterPlanModeTool(planGate.store, planGate.state),
        createExitPlanModeTool(planGate.store, planGate.state),
      );
    }
  }

  return tools;
};

/**
 * per-run 装配 Options(query() 的输入)。
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
    const chat = resolveModelSlot(
      this.infra.db,
      this.infra.config,
      "chat",
      options.modelId,
      this.infra.encryptor,
    );
    if (!chat.ok) {
      throw new AgentUnavailableError(chat.reason);
    }

    const settings = loadAppSettings(this.infra.db, this.infra.config);
    const tool = settings.models.tool
      ? resolveModelSlot(this.infra.db, this.infra.config, "tool", settings.models.tool, this.infra.encryptor)
      : undefined;

    return {
      chat: chat.binding,
      tool: tool?.ok ? tool.binding : chat.binding,
      temperature: settings.chat.temperature,
    };
  }

  /**
   * 按本轮配置装一份主 agent 的 Options。
   *
   * 为什么叫 build 不叫 resolve:resolve 只描述了"定模型"这一半,这个方法的
   * 主业是"用定好的模型 + 工作区 + 工具 + 记忆装一台能跑的 agent"。
   */
  build(options: AgentBuildOptions): ModelResolution {
    const models = this.resolveModels({ modelId: options.modelId });

    const tools = buildBaseTools(
      {
        skills: this.infra.skills,
        ...defined("workspace", options.workspace),
        ...defined("extraTools", options.extraTools),
        ...defined("planGate", options.planGate),
      },
    );

    const sections: PromptSection[] = [
      ...(this.infra.soulSection ? [this.infra.soulSection] : []),
      ...(options.workspace?.docsSection
        ? [options.workspace.docsSection]
        : []),
      ...(options.memoryFilesSection ? [options.memoryFilesSection] : []),
      ...(options.retrievedMemorySection ? [options.retrievedMemorySection] : []),
      createMemoryPromptSection(tools.some((tool) => tool.name === "save_memory")),
      ...(this.infra.skills.length
        ? [
          skillsToPromptSection([...this.infra.skills], {
            contextWindowTokens: models.chat.contextWindow
          })
        ]
        : []),
      createWebSearchPromptSection(),
      createWebFetchPromptSection(),
    ];

    const callSettings = {
      temperature: models.temperature,
      ...defined("maxOutputTokens", models.chat.maxOutputTokens),
    };

    // 子代理(harness 内置 subagent 工具):工具槽位模型 + 角色白名单。
    // 角色要的工具本轮不存在 → 不列出(模型看不见它),不在派发时才爆。
    const agents = subagentDefinitions(tools, this.binding(models.tool));

    return {
      options: {
        model: this.binding(models.chat),
        tools,
        systemPrompt: buildAgentSystemPrompt({ sections }),
        maxTurns: MAIN_AGENT_MAX_STEPS,
        ...(Object.keys(agents).length > 0 ? { agents } : {}),
        ...defined("canUseTool", options.canUseTool),
        callSettings,
        limits: { toolTimeoutMs: TOOL_TIMEOUT },
        // plan mode 提醒走 dynamicInstructions:它不能活在工具结果里(会被压缩折走),
        // 每次调模型前读一次 state —— enter/exit 中途变化下一步就能看见。
        ...(options.planGate
          ? {
            dynamicInstructions: () =>
              planGateReminder(options.planGate!.state.current()),
          }
          : {}),
      },
      mainModel: models.chat,
      toolModel: models.tool,
      callSettings,
    };
  }

  private binding(binding: ModelBinding): Options["model"] {
    return {
      languageModel: this.getModel(binding),
      id: binding.qualifiedModelId,
      ...(binding.contextWindow !== undefined
        ? { contextWindow: binding.contextWindow }
        : {}),
      ...(binding.maxOutputTokens !== undefined
        ? { maxOutputTokens: binding.maxOutputTokens }
        : {}),
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
}

/**
 * LanguageModel 实例缓存键 —— 只包含决定"实例本身"的字段。
 * temperature/maxOutputTokens 是 call settings,不进键。
 */
const modelCacheKey = (b: ModelBinding): string =>
  [b.kind, b.providerId, b.baseURL ?? "", b.modelId, b.apiKey].join("|");

/**
 * exactOptionalPropertyTypes 下 `key?: T | undefined` 不许显式传 undefined,
 * 只能条件展开 —— 这个 helper 就是那个展开的具名版:{...defined("workspace", w)}。
 */
export const defined = <K extends string, T>(
  key: K,
  value: T | undefined,
): { [P in K]: T } | Record<never, never> =>
  value !== undefined ? ({ [key]: value } as { [P in K]: T }) : {};

