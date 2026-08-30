import {
  createPlanGateState,
  createPlanWeaveTools,
  createSubagentTool,
  type AgentTool,
  type PlanGateState,
  type RequestPlanReview,
  type Skill
} from "@eva/harness";
import type { AgentObserver } from "@eva/harness";
import type { RunStreamEvent } from "@eva/shared";

import type { AppDatabase } from "../../db/index.js";
import { DrizzlePlanRepository } from "../../db/repositories/plan-repository.js";
import type { AgentFactory, ResolvedAgent } from "../agent-factory.js";
import { defined } from "../agent-factory.js";
import type { McpRegistry } from "../mcp/mcp-registry.js";
import { loadMemoryFilesSection, todayString } from "../memory/index.js";
import type {
  ObserverBridge,
  ObserverBridgeHooks
} from "../observability/observer-bridge.js";
import { createObserverBridge, fanout } from "../observability/observer-bridge.js";
import type { CaptureLevel } from "../observability/redact.js";
import { createRunRecorder, type RunRecorder } from "../observability/run-recorder.js";
import { createPlanGateStore, planGateRelPath } from "../plan-gate/index.js";
import { createPlanWeaveGateway, type PlanWeaveService } from "../plan-weave/index.js";
import { selectRunSkills, type RunSkillSelection } from "../skills/select-run-skills.js";
import { ReportGateway } from "../subagents/report-gateway.js";
import { SubagentRunner } from "../subagents/subagent-runner.js";
import { evaDataDir } from "../../paths.js";
import type { RunApprovalChannel } from "./run-approval-channel.js";
import type { RunInput } from "./run-preparation.js";

/** 进程级依赖 —— 与具体某个 run 无关,由组合根/路由一次性给齐。 */
export interface RunRuntimeBuilderDependencies {
  readonly db: AppDatabase;
  readonly logger: { warn(object: unknown, message?: string): void };
  readonly skills: readonly Skill[];
  readonly agents: AgentFactory;
  readonly mcp: McpRegistry;
  readonly planWeave: PlanWeaveService;
  /** 进程级 pino observer —— 永远是第二订阅者,不是唯一订阅者。 */
  readonly baseObserver: AgentObserver | undefined;
}

/** 本轮的事实 —— 每个 run 各一份。 */
export interface RunRuntimeScope {
  readonly runId: string;
  readonly sessionId: string;
  readonly input: RunInput;
  readonly approvals: RunApprovalChannel;
  /** 本轮 observability.captureContent,子 Run 与父 Run 定格同一档。 */
  readonly captureLevel: CaptureLevel;
  readonly observabilityEnabled: boolean;
  readonly abortSignal: AbortSignal;
  readonly emit: (event: RunStreamEvent) => void;
}

/** run-scoped 的观测三件套 —— 一次建好,主 agent 与子代理共用。 */
export interface RunObservability {
  readonly recorder: RunRecorder;
  readonly bridge: ObserverBridge;
  /** 喂给 agents.build 的 observer:bridge(agent="main") 与进程级 pino 的扇出。 */
  readonly observer: AgentObserver;
}

/** 「这轮 agent 能用什么」的产出。 */
export interface AgentRuntime {
  readonly resolved: ResolvedAgent;
  readonly skillSelection: RunSkillSelection;
}

/** 「这轮子代理怎么跑」的产出。 */
export interface SubagentRuntime {
  /** 注入主 agent 的 subagent 基元(无 join 工具 —— 回报走 push)。 */
  readonly tools: readonly AgentTool[];
  /** 与 run 同寿:主 loop 收尾前 drain 一次,finally 里 dispose。 */
  readonly reportGateway: ReportGateway;
}

/**
 * 一次 Run 的能力装配 —— 回答**「这轮 agent 能用什么」**这一个问题。
 *
 * 装的东西:记忆 section、skill 选择、plan gate、MCP 工具、plan weave 工具、
 * agent 本体、子代理运行时。这里**没有控制流**:没有 try/catch,不决定终态,
 * 不发 run_start/end。依赖多但只是接线 —— 这正是它作为独立文件的理由(§7.2)。
 *
 * 两个方法而不是一个,因为它们在 Run 里真的隔着一段距离:
 * `buildAgent()` 在流式开始**前**(prepareRunContext 要它的 mainModel 窗口信息),
 * `buildSubagents()` 在 `stream.open()` **后**(子代理的 SSE 帧要有连接可推)。
 * 把两者合成一个调用会把 SubagentRunner 的构造提前到 prepareRunContext 之前 ——
 * 构造本身是纯的,但 reportGateway 的存在区间会变宽,finally 的 dispose 语义随之漂移。
 * 顺序是行为,不合并。
 */
export class RunRuntimeBuilder {
  constructor(private readonly deps: RunRuntimeBuilderDependencies) {}

  /**
   * T49:run-scoped recorder + observer 桥。runId 在 recorder、agent 在绑定,
   * 没有隐式 current run(契约 3)。主 Agent 与前台子代理共用这个 recorder
   * (UNIQUE(run_id, seq) 成立的理由);后台子代理另建自己 Run 的 recorder。
   *
   * 放在 builder 而不是 coordinator:后台子代理那条路(createChildObserver)本来就要
   * 在这里现建 recorder + bridge。让这三个 import 只出现在一个文件里。
   */
  createObservability(
    scope: Pick<RunRuntimeScope, "runId" | "sessionId" | "captureLevel" | "observabilityEnabled">,
    hooks: ObserverBridgeHooks
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
    const bridge = createObserverBridge(recorder, hooks);

    return {
      recorder,
      bridge,
      // Pino 是第二订阅者:ledger 写挂了 Pino 照常,反之亦然。
      observer: fanout(bridge.forAgent("main"), this.deps.baseObserver)
    };
  }

  /**
   * 装这轮的 agent —— skill 选择 → plan gate → MCP/plan weave 工具 → build。
   *
   * 里面两处顺序不能动:
   * - skill auto-selection 必须在 build 之前(T44:它决定 prompt 列哪些 metadata,
   *   也决定本轮显式 activeToolNames = always ∪ thread 累积 ∪ 新选);
   * - memoryFilesSection 必须在 build 之前备好。它不依赖模型也不依赖工作区(~/.eva 全局),
   *   但要喂给 build 当 prompt section,而 prepareRunContext 又吃 build 出来的
   *   mainModel 窗口信息 —— 所以它排在这里,不和模型相关的准备混在一起。
   */
  async buildAgent(
    scope: RunRuntimeScope,
    observability: RunObservability
  ): Promise<AgentRuntime> {
    const { recorder } = observability;
    const { input, sessionId, runId } = scope;

    // MCP 连接在这里懒触发(首个 run 付一次成本,之后是空调用)。连不上的 server
    // 只在 registry 里记 error,工具缺席即可 —— MCP 不可用绝不让对话失败。
    await this.deps.mcp.ensureConnected();

    const memoryFilesSection = await loadMemoryFilesSection(evaDataDir(), todayString());

    const skillSelection = await selectRunSkills({
      db: this.deps.db,
      skills: this.deps.skills,
      agents: this.deps.agents,
      sessionId,
      modelId: input.modelId,
      humanText: input.humanText
    });
    recorder.record({
      agent: "main",
      kind: "skills_selected",
      payload: {
        selected: skillSelection.selectedSkills.map((skill) => skill.name),
        usedFallback: skillSelection.usedFallback
      }
    });

    const resolved = this.deps.agents.build({
      modelId: input.modelId,
      observer: observability.observer,
      extraTools: [
        ...this.deps.mcp.listTools(),
        // T46:plan weave 工具与 fs 工具同一个注入条件 —— 无 workspace 则无 plan_*。
        // gateway 把 workspaceId/runId 绑死在 server 侧,工具入参不带任何路径(契约 8)。
        ...(input.workspace
          ? createPlanWeaveTools(
              createPlanWeaveGateway(this.deps.planWeave, input.workspace.id, runId)
            )
          : [])
      ],
      requestApproval: scope.approvals.requestApproval,
      selectedSkills: skillSelection.selectedSkills,
      ...defined("workspace", input.workspace),
      ...defined("planGate", this.buildPlanGate(scope)),
      ...defined("memoryFilesSection", memoryFilesSection)
    });

    return { resolved, skillSelection };
  }

  /**
   * T45a:绑了 workspace 才装 plan gate。state 初值来自 DB 里该 session 的 active plan,
   * 之后由 enter/exit 工具在**同一份引用**上改 —— 不是 build 期快照。
   */
  private buildPlanGate(scope: RunRuntimeScope):
    | {
        state: PlanGateState;
        store: ReturnType<typeof createPlanGateStore>;
        requestPlanReview: RequestPlanReview;
      }
    | undefined {
    if (!scope.input.workspace) return undefined;

    const activePlan = new DrizzlePlanRepository(this.deps.db).findActive(scope.sessionId);
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

  /**
   * 阶段④:S7 子代理运行时 —— subagent 基元注入主 agent,回报走 push(无 join 工具)。
   *
   * sink 做两件事:① emit 推 SSE(前端子代理卡片拿流式过程);② recorder 攒事件,
   * 子代理 finish 时落库(parentToolCallId 隔离靠它,见 subagent-recorder)。
   * abortSignal 传给后台子代理:T15 §2.7 —— 用户点停止,子代理一起停,不留孤儿。
   */
  buildSubagents(
    scope: RunRuntimeScope,
    resolved: ResolvedAgent,
    bridge: ObserverBridge
  ): SubagentRuntime {
    const { emit } = scope;
    let reportGateway: ReportGateway | undefined;

    const runner = new SubagentRunner(this.deps.agents, {
      sessionId: scope.sessionId,
      db: this.deps.db,
      runId: scope.runId,
      model: resolved.mainModel.qualifiedModelId,
      captureLevel: scope.captureLevel,
      observer: this.deps.baseObserver,
      // T49:前台子代理绑父 Run 的 bridge(agent=taskId,seq 与主 Agent 同序列);
      // 后台子代理有自己 Run 的 recorder(T48 §2.3),seq 从 0 重新计。
      observerForTask: (taskId) => fanout(bridge.forAgent(taskId), this.deps.baseObserver),
      createChildObserver: (childRunId, taskId) =>
        fanout(
          createObserverBridge(
            createRunRecorder(
              {
                db: this.deps.db,
                logger: this.deps.logger,
                enabled: scope.observabilityEnabled,
                captureLevel: scope.captureLevel
              },
              { runId: childRunId, sessionId: scope.sessionId }
            )
          ).forAgent(taskId),
          this.deps.baseObserver
        ),
      ...(scope.input.workspace !== undefined ? { workspace: scope.input.workspace } : {}),
      extraTools: this.deps.mcp.listTools(),
      abortSignal: scope.abortSignal,
      requestApproval: scope.approvals.subagentRequestApproval,
      onSubagentEvent: (event) => {
        emit({ type: "subagent_update", ...event });
      },
      onNotice: (notice) => {
        reportGateway?.push(notice);
        // 卡片要能即时显示"已回报",不必等主 loop 注入。
        if (notice.kind === "reported") {
          emit({
            type: "subagent_report",
            taskId: notice.taskId,
            parentToolCallId: notice.parentToolCallId,
            description: notice.description,
            output: notice.output ?? ""
          });
        }
      }
    });

    reportGateway = new ReportGateway(() => runner.hasLiveTasks());

    return {
      tools: createSubagentTool({ runFork: runner.runFork }),
      reportGateway
    };
  }
}
