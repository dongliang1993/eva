import { toolOperationHooks } from "./tool-operations.js";
import { z } from "zod";
import {
  createPlanGateState,
  textResult,
  tool,
  type PipelineTool,
  type Skill,
} from "@eva/harness";
import type { HarnessMessage } from "@eva/harness";
import type { RunStreamEvent } from "@eva/shared";

import type { AppDatabase } from "../../db/index.js";
import type { AppConfig } from "../../config.js";
import type { DrizzlePlanRepository } from "../plan-gate/index.js";
import type {
  ApprovalGateway,
  ApprovalPolicyStore,
} from "../approvals/index.js";
import type { AgentFactory, ResolvedOptions } from "./agent-factory.js";
import { defined } from "./agent-factory.js";
import type { McpRegistry } from "../mcp/index.js";
import { createMemoryTools, loadMemoryFilesSection, todayString } from "../memory/index.js";
import {
  createRunRecorder,
  createRunTrajectory,
  type CaptureLevel,
  type RunRecorder,
} from "../observability/index.js";
import { createPlanGateStore, planGateRelPath } from "../plan-gate/index.js";
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

/** 装配期定形的消息消费者(recorder 的输入域)。 */
export interface RunConsumers {
  /** run_events 的 recorder(轨迹页);观测关着时短路,不写。 */
  readonly recorder: RunRecorder;
  /** HarnessMessage 的第二订阅者(pino 日志);可以为 undefined。 */
  readonly pino: ((message: HarnessMessage) => void) | undefined;
}

/** 每个子代理任务一个 trajectory(agent = taskId)。 */
export interface SubagentTrajectory {
  record(message: HarnessMessage): void;
}

export interface RunObservability {
  readonly recorder: RunRecorder;
  /** 每次调用一个新 trajectory?不 —— 同一 recorder,per-agent 由 createRunTrajectory 内部不区分。 */
  readonly trajectory: () => SubagentTrajectory;
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
  readonly resolved: ResolvedOptions;
  /** 主 agent 之外、本轮追加的工具(子代理)。 */
  readonly additionalTools: readonly PipelineTool[];
  readonly consumers: RunConsumers;
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
    input: RunInput,
    events: {
      readonly record: (event: {
        readonly kind: "approval_asked" | "approval_decided";
        readonly toolCallId: string;
        readonly payload?: unknown;
      }) => void;
    }
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
      events,
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
    // trajectory 的 request 上下文(provider/model)在模型解析后才有 ——
    // 由 coordinator 在流式阶段用 resolved 构造(recorder 共享同一实例)。
    return { recorder, trajectory: () => { throw new Error("use coordinator trajectory"); } };
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
      additionalTools: this.buildSubagentTools(scope, resolved, sharedTools, observability.recorder),
      consumers: {
        recorder: observability.recorder,
        // pino 是第二订阅者:coordinator 在流式阶段构造(它有完整 logger)。
        pino: undefined,
      },
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
    resolved: ResolvedOptions,
    sharedTools: readonly PipelineTool[],
    recorder: RunRecorder,
  ): readonly PipelineTool[] {
    const runner = new SubagentRunner(this.deps.agents, {
      sessionId: scope.sessionId,
      db: this.deps.db,
      runId: scope.runId,
      model: resolved.toolModel,
      ...(scope.input.workspace !== undefined ? { workspace: scope.input.workspace } : {}),
      extraTools: sharedTools,
      abortSignal: scope.abortSignal,
      canUseTool: scope.permissions.canUseTool,
      hooksForTask: (taskId) =>
        toolOperationHooks(this.deps.db, scope.runId, taskId),
      trajectoryForTask: (taskId) =>
        createRunTrajectory(recorder, {
          provider: resolved.toolModel.providerId,
          modelId: resolved.toolModel.modelId,
          callSettings: {},
        }),
      onSubagentEvent: (event) => {
        scope.emit({ type: "subagent_update", ...event });
      },
    });

    return [createSubagentBridgeTool(runner)];
  }
}

/** 子代理桥:SubagentRunner(消息流 + 台账)包成 subagent 工具。 */
const createSubagentBridgeTool = (runner: SubagentRunner): PipelineTool => {
  const subagentSchema = z.object({
    description: z.string().min(1).describe(
      "A short (3-5 word) description of the delegated task, for display."
    ),
    prompt: z.string().min(1).describe(
      "The complete, self-contained task for the subagent. It does not share this " +
      "conversation's context, so include everything it needs."
    ),
    subagent: z.string().optional().describe(
      "Subagent type to fork. Defaults to explorer."
    ),
  });

  return tool({
    name: "subagent",
    description: [
      "Delegate a self-contained task to a subagent (a separate agent that works in its own " +
      "context) to offload focused, independent work — research, a scoped analysis — so it does " +
      "not consume this conversation's context.",
      "The subagent returns its result, not its intermediate steps. Give it a complete, " +
      "standalone prompt: it does not see this conversation.",
      "The tool waits for the child and returns its final result. Independent calls may run in parallel."
    ].join("\n"),
    inputSchema: subagentSchema,
    async execute({ description, prompt, subagent: type }, extra) {
      const id = crypto.randomUUID();
      // parentToolCallId 用 SDK 派给这次调用的 toolUseID —— 子代理进程消息、SSE 帧、
      // 主对话里的卡片三者靠它一对一归位。SDK 总会有,兜底只是防御。
      const parentToolCallId = extra.toolUseID ?? `task-${id}`;

      const result = await runner.runFork({
        taskId: id,
        parentToolCallId,
        subagentType: type ?? "explorer",
        description,
        prompt,
        abortSignal: extra.signal,
      });

      return textResult(result.text);
    }
  });
};
