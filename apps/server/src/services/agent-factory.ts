import type { LanguageModel } from "ai";
import type { Agent, RequestApproval } from "@eva/harness";

import {
  AgentUnavailableError,
  createConfiguredAgent,
  resolveAgentRuntimeConfig,
  toAgentModel,
  type ResolvedRuntimeModelBinding,
  type ResolvedWorkspaceContext
} from "../agent.js";
import type { AppInfrastructure } from "../types/common.js";

export interface AgentResolveOptions {
  readonly requestedModelId?: string | undefined;
  readonly requestApproval?: RequestApproval | undefined;
  readonly workspace?: ResolvedWorkspaceContext | undefined;
}

export interface ResolvedAgent {
  readonly agent: Agent;
  readonly mainModel: ResolvedRuntimeModelBinding;
  readonly toolModel?: ResolvedRuntimeModelBinding;
}

/**
 * LanguageModel 实例缓存键 —— 只包含决定"实例本身"的字段。
 * temperature / maxOutputTokens 是 call settings,不进键(否则每换一次温度就新建实例)。
 */
const modelCacheKey = (b: ResolvedRuntimeModelBinding): string =>
  [b.providerType, b.providerId, b.baseURL ?? "", b.modelId, b.apiKey].join("|");

/**
 * per-run 解析 agent。
 *
 * 为什么不在装配期建单例:模型/温度/工作区都是 per-run 决策(用户在 UI 换模型、
 * 子代理走 toolModel、未来 per-workspace 工具集),单例把这些全钉死了。
 * 昂贵的只有 provider 实例构造,所以只缓存 LanguageModel。
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

  /** @throws AgentUnavailableError 当没有可用的 provider/模型配置时。 */
  resolve(options: AgentResolveOptions = {}): ResolvedAgent {
    const runtime = resolveAgentRuntimeConfig({
      config: this.infra.config,
      db: this.infra.db,
      ...(options.requestedModelId !== undefined
        ? { requestedModelId: options.requestedModelId }
        : {})
    });

    if (!runtime.ok) {
      throw new AgentUnavailableError(runtime.reason);
    }

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
        ...(options.workspace !== undefined ? { workspace: options.workspace } : {})
      },
      runtime,
      (binding) => this.getModel(binding)
    );

    return {
      agent,
      mainModel: runtime.value.mainModel,
      ...(runtime.value.toolModel ? { toolModel: runtime.value.toolModel } : {})
    };
  }

  private getModel(binding: ResolvedRuntimeModelBinding): LanguageModel {
    const key = modelCacheKey(binding);
    const cached = this.models.get(key);

    if (cached) {
      return cached;
    }

    const model = toAgentModel(binding);
    this.models.set(key, model);

    return model;
  }
}