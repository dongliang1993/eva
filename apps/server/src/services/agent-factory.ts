import type { LanguageModel } from "ai";
import type { Agent, AgentTool, RequestApproval } from "@eva/harness";
import { createAgent, filterToolsForRole, missingRoleTools, SUBAGENT_MAX_STEPS } from "@eva/harness";

import {
  AgentUnavailableError,
  buildBaseTools,
  createConfiguredAgent,
  toAgentModel,
  type ResolvedWorkspaceContext
} from "../agent.js";
import type { AppInfrastructure } from "../types/common.js";
import {
  resolveModelSlot,
  type ModelBinding
} from "./providers/model-resolver.js";
import { loadAppSettings } from "./settings/app-settings.js";

export interface AgentResolveOptions {
  readonly requestedModelId?: string | undefined;
  readonly requestApproval?: RequestApproval | undefined;
  readonly workspace?: ResolvedWorkspaceContext | undefined;
  /** 进程级外部工具（MCP）；由路由从 registry 取好传进来。 */
  readonly extraTools?: readonly AgentTool[] | undefined;
  /** per-run 读好的人类可读记忆 section（L1 MEMORY.md + 近几天日记）。 */
  readonly memoryFilesSection?: import("@eva/harness").PromptSection | undefined;
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

/**
 * LanguageModel 实例缓存键 —— 只包含决定"实例本身"的字段。
 * temperature/maxOutputTokens 是 call settings,不进键。
 */
const modelCacheKey = (b: ModelBinding): string =>
  [b.kind, b.providerId, b.baseURL ?? "", b.modelId, b.apiKey].join("|");

/**
 * per-run 解析 agent。
 *
 * 为什么不在装配期建单例:模型/温度/工作区都是 per-run 决策(用户在 UI 换模型、
 * per-workspace 工具集),单例把这些全钉死了。昂贵的只有 provider 实例构造,
 * 所以只缓存 LanguageModel。
 */
export class AgentFactory {
  private readonly models = new Map<string, LanguageModel>();

  constructor(private readonly infra: AppInfrastructure) {}

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
    readonly requestedModelId?: string | undefined;
  } = {}): ResolvedModels {
    const chat = resolveModelSlot(this.infra.db, this.infra.config, "chat", options.requestedModelId);
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

  /** @throws AgentUnavailableError 当没有可用的 provider/模型配置时。 */
  resolve(options: AgentResolveOptions = {}): ResolvedAgent {
    const models = this.resolveModels({
      ...(options.requestedModelId !== undefined
        ? { requestedModelId: options.requestedModelId }
        : {})
    });

    const agent = createConfiguredAgent(
      {
        skills: [...this.infra.skills],
        ...(this.infra.soulSection !== undefined
          ? { soulSection: this.infra.soulSection }
          : {}),
        ...(this.infra.observer !== undefined ? { observer: this.infra.observer } : {}),
        ...(options.requestApproval !== undefined
          ? { requestApproval: options.requestApproval }
          : {}),
        ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
        ...(options.extraTools !== undefined ? { extraTools: options.extraTools } : {}),
        ...(options.memoryFilesSection !== undefined
          ? { memoryFilesSection: options.memoryFilesSection }
          : {})
      },
      models,
      (binding) => this.getModel(binding)
    );

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
    readonly workspace?: ResolvedWorkspaceContext | undefined;
    readonly extraTools?: readonly AgentTool[] | undefined;
    readonly temperature?: number | undefined;
  }): Agent {
    const models = this.resolveModels();
    const baseTools = buildBaseTools(
      {
        skills: [...this.infra.skills],
        ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
        ...(options.extraTools !== undefined ? { extraTools: options.extraTools } : {})
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
        ...(options.temperature !== undefined
          ? { temperature: options.temperature }
          : {})
      },
      ...(this.infra.observer !== undefined ? { observer: this.infra.observer } : {})
    });
  }
}