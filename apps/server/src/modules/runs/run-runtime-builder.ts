import { recordToolExecution } from "./tool-operations.js";
import {
  createPlanGateState,
  createSubagentTool,
  type AgentTool,
  type PlanGateState,
  type RequestPlanReview,
  type Skill
} from "@eva/harness";
import type { AgentObserver } from "@eva/harness";
import type { RunStreamEvent } from "@eva/shared";

import type { AppDatabase } from "../../db/index.js";
import type { AppConfig } from "../../config.js";
import type { DrizzlePlanRepository } from "../plan-gate/index.js";
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
import { SubagentRunner } from "../subagents/index.js";
import { evaDataDir } from "../../paths.js";
import type { RunApprovalChannel } from "./run-approval-channel.js";
import type { RunInput } from "./run-preparation.js";
import type { MemoryAutomationService } from "../memory/index.js";
import type { AppSettings } from "@eva/shared";
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
  readonly baseObserver: AgentObserver | undefined;
  readonly memoryAutomation?: MemoryAutomationService | undefined;
}

export interface RunRuntimeScope {
  readonly runId: string;
  readonly sessionId: string;
  readonly input: RunInput;
  readonly approvals: RunApprovalChannel;
  readonly captureLevel: CaptureLevel;
  readonly observabilityEnabled: boolean;
  readonly abortSignal: AbortSignal;
  readonly emit: (event: RunStreamEvent) => void;
}

export interface RunObservability {
  readonly recorder: RunRecorder;
  readonly bridge: ObserverBridge;
  readonly observer: AgentObserver;
}

export interface AgentRuntime {
  readonly resolved: ResolvedAgent;
  /** MCP/memory capabilities frozen once for this run and reused by child agents. */
  readonly sharedTools: readonly AgentTool[];
  readonly memorySettings: AppSettings["memory"];
  readonly memoryRetrieval?: MemoryRetrievalResult | undefined;
}

export interface SubagentRuntime {
  readonly tools: readonly AgentTool[];
}

export class RunRuntimeBuilder {
  constructor(private readonly deps: RunRuntimeBuilderDependencies) { }

  createObservability(
    scope: Pick<RunRuntimeScope, "runId" | "sessionId" | "captureLevel" | "observabilityEnabled">
  ): RunObservability {
    const recorder = createRunRecorder(
      {
        db: this.deps.db,
        logger: this.deps.logger,
        enabled: scope.observabilityEnabled,
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

  async buildAgent(
    scope: RunRuntimeScope,
    observability: RunObservability
  ): Promise<AgentRuntime> {
    scope.abortSignal.throwIfAborted();
    const { input } = scope;

    // MCP 连接在这里懒触发(首个 run 付一次成本,之后是空调用)。连不上的 server
    // 只在 registry 里记 error,工具缺席即可 —— MCP 不可用绝不让对话失败。
    await this.deps.mcp.ensureConnected();

    const memoryFilesSection = await loadMemoryFilesSection(evaDataDir(), todayString());
    const memorySettings = this.deps.memoryAutomation?.settingsSnapshot()
      ?? loadAppSettings(this.deps.db, this.deps.config).memory;
    const retrievedMemorySection = this.deps.memoryAutomation?.retrieve({
      query: input.humanText,
      ...(input.workspace ? { workspaceId: input.workspace.id } : {}),
      settings: memorySettings
    });
    const tools = [
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
    const resolved = this.deps.agents.build({
      modelId: input.modelId,
      observer: observability.observer,
      extraTools: tools,
      requestApproval: scope.approvals.requestApproval,
      ...defined("workspace", input.workspace),
      ...defined("planGate", this.buildPlanGate(scope)),
      ...defined("memoryFilesSection", memoryFilesSection),
      ...defined("retrievedMemorySection", retrievedMemorySection?.section)
    });

    return {
      resolved,
      sharedTools: tools,
      memorySettings,
      ...defined("memoryRetrieval", retrievedMemorySection)
    };
  }

  private buildPlanGate(scope: RunRuntimeScope):
    | {
      state: PlanGateState;
      store: ReturnType<typeof createPlanGateStore>;
      requestPlanReview: RequestPlanReview;
    }
    | undefined {
    if (!scope.input.workspace) return undefined;

    const activePlan = this.deps.plans.findActive(scope.sessionId);
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
    // 同一个引用交给两边:agent 的 enter/exit 工具在上面改,审批通道读它判「plan 文件写直放」。
    scope.approvals.bindPlanGate(state);

    return {
      state,
      store: createPlanGateStore({
        db: this.deps.db,
        sessionId: scope.sessionId,
        workspace: scope.input.workspace
      }),
      requestPlanReview: scope.approvals.requestPlanReview
    };
  }

  buildSubagents(
    scope: RunRuntimeScope,
    runtime: AgentRuntime,
    bridge: ObserverBridge
  ): SubagentRuntime {
    const { emit } = scope;
    const { resolved } = runtime;
    const runner = new SubagentRunner(this.deps.agents, {
      sessionId: scope.sessionId,
      db: this.deps.db,
      runId: scope.runId,
      model: resolved.toolModel,
      observerForTask: (taskId) => fanout(bridge.forAgent(taskId), this.deps.baseObserver),
      ...(scope.input.workspace !== undefined ? { workspace: scope.input.workspace } : {}),
      extraTools: runtime.sharedTools,
      abortSignal: scope.abortSignal,
      requestApproval: scope.approvals.requestApproval,
      toolExecutionForTask: (taskId) =>
        recordToolExecution(this.deps.db, scope.runId, taskId),
      onSubagentEvent: (event) => {
        emit({ type: "subagent_update", ...event });
      },

    });

    return {
      tools: createSubagentTool({ runFork: runner.runFork })
    };
  }
}
