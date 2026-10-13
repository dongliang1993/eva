import { toolOperationHooks } from "./tool-operations.js";
import {
  createSubagentTool,
  type PipelineTool,
  type Skill
} from "@eva/harness";
import type { AgentObserver } from "@eva/harness";
import type { RunStreamEvent } from "@eva/shared";

import type { AppDatabase } from "../../db/index.js";
import type { AppConfig } from "../../config.js";
import type { DrizzlePlanRepository } from "../plan-gate/index.js";
import type {
  ApprovalGateway,
  ApprovalPolicyStore,
} from "../approvals/index.js";
import type { AgentFactory, ResolvedAgent } from "./agent-factory.js";
import { defined } from "./agent-factory.js";
import type { McpRegistry } from "../mcp/index.js";
import { createMemoryTools, loadMemoryFilesSection, todayString } from "../memory/index.js";
import {
  createObserverBridge,
  fanout,
  createRunRecorder,
  type CaptureLevel,
  type ObserverBridge,
  type RunRecorder,
} from "../observability/index.js";
import { createPlanGateStore, planGateRelPath } from "../plan-gate/index.js";
import { createPlanGateState } from "@eva/harness";
import { createRunPermissions, type RunPermissions } from "./run-permissions.js";
import { SubagentRunner } from "../subagents/index.js";
import { evaDataDir } from "../../paths.js";

import type { RunInput } from "./run-preparation.js";
import type { MemoryAutomationService } from "../memory/index.js";
import { loadAppSettings } from "../settings/index.js";
import type { MemoryRetrievalResult } from "../memory/index.js";

export interface RunRuntimeBuilderDependencies {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly logger: { warn(object: unknown, message?: string): void };
  readonly skills: readonly Skill[];
  readonly agents: AgentFactory;
  readonly mcp: McpRegistry;
  readonly plans: DrizzlePlanRepository;
  readonly approvals: ApprovalGateway;
  readonly approvalPolicies: ApprovalPolicyStore;
  readonly baseObserver: AgentObserver | undefined;
  readonly memoryAutomation?: MemoryAutomationService | undefined;
}

/** 装配一次 run 需要知道的「这一轮是谁」。 */
export interface RunRuntimeScope {
  readonly runId: string;
  readonly sessionId: string;
  readonly input: RunInput;
  readonly permissions: RunPermissions;
  readonly abortSignal: AbortSignal;
  readonly emit: (event: RunStreamEvent) => void;
}

export interface RunObservability {
  readonly recorder: RunRecorder;
  readonly bridge: ObserverBridge;
  readonly observer: AgentObserver;
}

/**
 * run 成功收尾后要入队的记忆提取 —— 装配时一次算好,收尾只管照着入队。
 * 不需要提取(关着 / 没有 memory 服务)时为 undefined。
 */
export interface MemoryExtractionPlan {
  readonly modelId: string;
  readonly mode: "review" | "automatic";
  readonly workspaceId?: string | undefined;
}

/** 这一轮 agent 有什么 —— 装配阶段的全部产出。 */
export interface AgentRuntime {
  readonly resolved: ResolvedAgent;
  /** 主 agent 之外、本轮追加的工具(子代理)。 */
  readonly additionalTools: readonly PipelineTool[];
  readonly extraction?: MemoryExtractionPlan | undefined;
  readonly memoryRetrieval?: MemoryRetrievalResult | undefined;
}

export class RunRuntimeBuilder {
  constructor(private readonly deps: RunRuntimeBuilderDependencies) { }

  /**
   * 权限链(coordinator 在 agent 装配之前调):
   * plan gate 的 state/store 在这里定形,permissions 与 agent 工具集共用同一引用。
   * 无 workspace 的 run 不带 planGate(enter/exit 工具与 plan 路径直放都缺席)。
   */
  createPermissions(
    run: { readonly id: string; readonly emit: (event: RunStreamEvent) => void },
    input: RunInput
  ): RunPermissions {
    const planGate = input.workspace
      ? (() => {
        const activePlan = this.deps.plans.findActive(input.sessionId);
        const state = createPlanGateState(
          activePlan
            ? {
              active: true,
              planId: activePlan.id,
              planPath: activePlan.path,
              planRelPath: planGateRelPath(activePlan.id)
            }
            : { active: false }
        );
        return {
          state,
          store: createPlanGateStore({
            db: this.deps.db,
            sessionId: input.sessionId,
            workspace: input.workspace
          })
        };
      })()
      : undefined;
    return createRunPermissions({
      approvals: this.deps.approvals,
      approvalPolicies: this.deps.approvalPolicies,
      runId: run.id,
      sessionId: input.sessionId,
      emit: run.emit,
      ...(planGate !== undefined ? { planGate } : {})
    });
  }

  /** 本轮的诊断记录器。观测关着时 recorder 照样返回,只是不写。 */
  createObservability(scope: {
    readonly runId: string;
    readonly sessionId: string;
    readonly enabled: boolean;
    readonly captureLevel: CaptureLevel;
  }): RunObservability {
    const recorder = createRunRecorder(
      {
        db: this.deps.db,
        logger: this.deps.logger,
        enabled: scope.enabled,
        captureLevel: scope.captureLevel
      },
      { runId: scope.runId, sessionId: scope.sessionId }
    );
    const bridge = createObserverBridge(recorder);

    return {
      recorder,
      bridge,
      // Pino 是第二订阅者:ledger 写挂了 Pino 照常,反之亦然。
      observer: fanout(bridge.forAgent("main"), this.deps.baseObserver)
    };
  }

  /**
   * 装出这一轮的 agent:MCP 与记忆能力 → 模型与 prompt → 子代理工具。
   *
   * MCP/记忆工具在这里冻结一次,子代理复用同一份 —— 主/子在同一个 run 里
   * 看到的能力必须一致。
   */
  async assemble(scope: RunRuntimeScope, observability: RunObservability): Promise<AgentRuntime> {
    scope.abortSignal.throwIfAborted();
    const { input } = scope;

    // MCP 连接在这里懒触发(首个 run 付一次成本,之后是空调用)。连不上的 server
    // 只在 registry 里记 error,工具缺席即可 —— MCP 不可用绝不让对话失败。
    await this.deps.mcp.ensureConnected();

    const memoryFilesSection = await loadMemoryFilesSection(evaDataDir(), todayString());
    const memorySettings = this.deps.memoryAutomation?.settingsSnapshot()
      ?? loadAppSettings(this.deps.db, this.deps.config).memory;
    const memoryRetrieval = this.deps.memoryAutomation?.retrieve({
      query: input.humanText,
      ...(input.workspace ? { workspaceId: input.workspace.id } : {}),
      settings: memorySettings
    });
    const sharedTools = [
      ...this.deps.mcp.listTools(),
      ...createMemoryTools(this.deps.db, this.deps.config, {
        workspaceId: input.workspace?.id,
        sessionId: scope.sessionId,
        runId: scope.runId,
        userMessageId: input.userMessageId,
        enabled: memorySettings.enabled
      }),
    ];

    scope.abortSignal.throwIfAborted();
    // plan gate 工具(enter/exit)与权限链共用同一个 state 引用 ——
    // permissions.planGate 是装配期定下来的,工具执行中途 enter/exit 改的就是它。
    const planGate = scope.permissions.planGate;
    const resolved = this.deps.agents.build({
      modelId: input.modelId,
      observer: observability.observer,
      extraTools: sharedTools,
      canUseTool: scope.permissions.canUseTool,
      ...defined("workspace", input.workspace),
      ...defined("planGate", planGate),
      ...defined("memoryFilesSection", memoryFilesSection),
      ...defined("retrievedMemorySection", memoryRetrieval?.section)
    });

    const extraction: MemoryExtractionPlan | undefined =
      this.deps.memoryAutomation && memorySettings.enabled && memorySettings.autoSummarize
        ? {
          modelId: resolved.toolModel.qualifiedModelId,
          mode: memorySettings.autoSummarizeMode,
          ...(input.workspace ? { workspaceId: input.workspace.id } : {})
        }
        : undefined;

    return {
      resolved,
      additionalTools: this.buildSubagentTools(scope, resolved, sharedTools, observability.bridge),
      ...defined("extraction", extraction),
      ...defined("memoryRetrieval", memoryRetrieval)
    };
  }

  /**
   * 子代理是 awaited 工具:构造只是备好 runner,它的事件要等工具在流式循环里
   * 被调用才发出 —— 所以这里不依赖 SSE 是否已经打开。
   */
  private buildSubagentTools(
    scope: RunRuntimeScope,
    resolved: ResolvedAgent,
    sharedTools: readonly PipelineTool[],
    bridge: ObserverBridge
  ): readonly PipelineTool[] {
    const runner = new SubagentRunner(this.deps.agents, {
      sessionId: scope.sessionId,
      db: this.deps.db,
      runId: scope.runId,
      model: resolved.toolModel,
      observerForTask: (taskId) => fanout(bridge.forAgent(taskId), this.deps.baseObserver),
      ...(scope.input.workspace !== undefined ? { workspace: scope.input.workspace } : {}),
      extraTools: sharedTools,
      abortSignal: scope.abortSignal,
      canUseTool: scope.permissions.canUseTool,
      toolExecutionForTask: (taskId) =>
        toolOperationHooks(this.deps.db, scope.runId, taskId),
      onSubagentEvent: (event) => {
        scope.emit({ type: "subagent_update", ...event });
      },
    });

    return createSubagentTool({ runFork: runner.runFork });
  }
}
