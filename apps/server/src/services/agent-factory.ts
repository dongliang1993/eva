import type { LanguageModel } from "ai";
import type { Agent, AgentTool, RequestApproval } from "@eva/harness";

import {
  AgentUnavailableError,
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
        ...(options.extraTools !== undefined ? { extraTools: options.extraTools } : {})
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
}