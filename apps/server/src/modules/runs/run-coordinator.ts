import { recordToolExecution } from "./tool-operations.js";
import { randomUUID } from "node:crypto";

import type { AgentObserver, Skill } from "@eva/harness";
import { toErrorMessage, type AppSettings, type RunStreamEvent } from "@eva/shared";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import type { RunFailureLayer } from "../../db/schema.js";
import type { AgentFactory } from "./agent-factory.js";
import type {
  ApprovalGateway,
  ApprovalPolicyStore,
} from "../approvals/index.js";
import type { McpRegistry } from "../mcp/index.js";
import type { DrizzleMessageRepository } from "../sessions/index.js";
import type { DrizzlePlanRepository } from "../plan-gate/index.js";
import type { DrizzleRunRepository, RunRecord } from "./run-repository.js";
import type { DrizzleSessionRepository } from "../sessions/index.js";
import type { RunHub } from "./run-hub.js";
import type { RunRegistry } from "./run-registry.js";
import type { SessionService } from "../sessions/index.js";
import { loadAppSettings } from "../settings/index.js";
import type { WorkspaceStore } from "../workspaces/index.js";
import type { RunEventStream } from "../../transports/sse/event-stream.js";
import { runRequestSchema, type RunRequest } from "../../types/runs.js";
import { AssistantMessageRecorder, type RecordedAssistantRun } from "./assistant-message-recorder.js";
import { RunApprovalChannel } from "./run-approval-channel.js";
import { runStatusFor } from "./run-repository.js";
import {
  prepareRunContext,
  prepareRunInput,
  prepareRunWorkspace,
  type RunInput,
  type RunPreparationDependencies
} from "./run-preparation.js";
import { RunRuntimeBuilder, type AgentRuntime } from "./run-runtime-builder.js";
import type { MemoryAutomationService } from "../memory/index.js";

export interface CoordinatorDependencies {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly logger: { warn(object: unknown, message?: string): void };
  readonly skills: readonly Skill[];
  readonly baseObserver: AgentObserver | undefined;
  readonly agents: AgentFactory;
  readonly session: SessionService;
  readonly approvals: ApprovalGateway;
  readonly approvalPolicies: ApprovalPolicyStore;
  readonly runRegistry: RunRegistry;
  readonly workspaces: WorkspaceStore;
  readonly mcp: McpRegistry;
  readonly sessions: DrizzleSessionRepository;
  readonly messages: DrizzleMessageRepository;
  readonly runs: DrizzleRunRepository;
  readonly plans: DrizzlePlanRepository;
  readonly memoryAutomation?: MemoryAutomationService | undefined;
}

export interface RunRequestLog {
  info(object: unknown, message?: string): void;
  warn(object: unknown, message?: string): void;
  error(object: unknown, message?: string): void;
}

export type RunOutcome =
  | { readonly kind: "streamed" }
  | { readonly kind: "duplicate"; readonly runId: string; readonly sessionId: string; readonly status: string }
  | { readonly kind: "rejected"; readonly error: unknown; readonly runId?: string; readonly sessionId?: string };

/** 一次 run 在内存里的身份与句柄,生命期就是 run() 这一次调用。 */
interface ActiveRun {
  readonly id: string;
  readonly controller: AbortController;
  readonly hub: RunHub;
  readonly emit: (event: RunStreamEvent) => void;
}

/**
 * run 推进到了哪里。收尾只看它:
 * - 没有 sessionId:输入没落库,没有台账可写;
 * - 没有 recorder:还没开始流式,终态记 failureLayer;
 * - 有 recorder:已经在写 assistant 消息,终态以消息为准;
 * - streamOpened:HTTP 头已发,错误只能从 SSE 告知。
 */
interface RunProgress {
  sessionId?: string;
  userMessageId?: string;
  failureLayer?: RunFailureLayer | undefined;
  recorder?: AssistantMessageRecorder;
  extraction?: AgentRuntime["extraction"];
  streamOpened: boolean;
}

/** ① 的产出:落好库的输入 + 本轮的观测设置(台账与诊断记录器共用这一份)。 */
interface AcceptedRun {
  readonly input: RunInput;
  readonly observability: AppSettings["observability"];
}

/** ② 的产出:带工作区的输入、审批通道,以及装好的 agent。 */
interface AssembledRun extends AgentRuntime {
  readonly input: RunInput;
  readonly approvals: RunApprovalChannel;
}

/** 进入一个准备阶段:在这期间抛出的错误,台账记为这一层的失败。 */
const inStage = <T>(progress: RunProgress, layer: RunFailureLayer, stage: () => Promise<T>): Promise<T> => {
  progress.failureLayer = layer;
  return stage();
};

/**
 * 一次 Run 的编排。这里只有顺序,每一步的细节在被调用的能力里。
 *
 * ① 接收   同一事务:会话互斥 → 落用户消息 → 开台账行(在第一次 await 之前)
 * ② 装配   工作区 → agent(MCP / 记忆 / plan gate / 子代理 / 模型)    失败层 routing
 * ③ 上下文 本轮分支可见的历史 → 模型消息                            失败层 context
 * ④ 开流   SSE 头 → run_start
 * ⑤ 流式   agent 事件 → assistant 消息 + 订阅者
 *    收尾   同一事务:终态 + 记忆提取入队
 *
 * 顺序不能换的地方:台账(①)要早于模型解析(②),否则 provider 配错时
 * 留不下 routing 失败的记录;工作区要早于 agent,因为工具集依赖工作区。
 */
export class Coordinator {
  private readonly preparation: RunPreparationDependencies;
  private readonly builder: RunRuntimeBuilder;

  constructor(private readonly deps: CoordinatorDependencies) {
    this.preparation = {
      db: deps.db,
      logger: deps.logger,
      session: deps.session,
      workspaces: deps.workspaces,
      sessions: deps.sessions,
      messages: deps.messages,
      runs: deps.runs
    };
    this.builder = new RunRuntimeBuilder({
      config: deps.config,
      db: deps.db,
      logger: deps.logger,
      skills: deps.skills,
      agents: deps.agents,
      mcp: deps.mcp,
      baseObserver: deps.baseObserver,
      plans: deps.plans,
      memoryAutomation: deps.memoryAutomation
    });
  }

  async run(body: unknown, stream: RunEventStream, log: RunRequestLog): Promise<RunOutcome> {
    const parsed = runRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return { kind: "rejected", error: parsed.error };

    const runId = parsed.data.requestId ?? randomUUID();
    const existing = this.deps.runs.findById(runId);
    if (existing) return duplicateOf(existing);

    const run = this.register(runId);
    const progress: RunProgress = { streamOpened: false };
    try {
      // ① 接收(同步事务)
      const accepted = this.accept(run, parsed.data, progress);
      // ② 装配 ③ 上下文 —— 抛错时台账记对应的失败层
      const assembled = await inStage(progress, "routing", () => this.assemble(run, accepted));
      const context = await inStage(progress, "context", () =>
        prepareRunContext(this.preparation, assembled.input, assembled.resolved));
      run.controller.signal.throwIfAborted();
      this.deps.memoryAutomation?.commitRetrieval(run.id, assembled.memoryRetrieval);
      progress.failureLayer = undefined;

      // ④ 开流 ⑤ 流式
      this.openStream(run, stream, log, progress);
      const recorder = this.startRecording(run, assembled, progress);
      for await (const event of assembled.resolved.agent.stream({
        messages: context.modelMessages,
        onToolExecution: recordToolExecution(this.deps.db, run.id, "main"),
        abortSignal: run.controller.signal,
        additionalTools: [...assembled.additionalTools],
      })) {
        recorder.record(event);
        run.emit(event);
      }

      run.emit({ type: "end", finishReason: this.settle(run, progress) });
      return { kind: "streamed" };
    } catch (error) {
      return this.fail(run, progress, error, log);
    } finally {
      this.deps.approvals.cancelByRun(run.id);
      this.deps.runRegistry.unregister(run.id);
    }
  }

  private register(runId: string): ActiveRun {
    const controller = this.deps.runRegistry.register(runId);
    const hub = this.deps.runRegistry.hubFor(runId)!;
    return { id: runId, controller, hub, emit: (event) => hub.publish(event) };
  }

  /** ① 同步、单事务:到这一步结束,用户的输入与台账行要么都在,要么都不在。 */
  private accept(run: ActiveRun, request: RunRequest, progress: RunProgress): AcceptedRun {
    const observability = loadAppSettings(this.deps.db, this.deps.config).observability;
    const input = this.deps.db.transaction(() => {
      const accepted = prepareRunInput(this.preparation, request, run.id);
      this.deps.runs.start({
        id: run.id, sessionId: accepted.sessionId, userMessageId: accepted.userMessageId,
        requestedModel: accepted.modelId, captureLevel: observability.captureContent,
      });
      return accepted;
    });
    progress.sessionId = input.sessionId;
    progress.userMessageId = input.userMessageId;
    // 准备期间也可能有人重连:先让 hub 知道会话;快照要等开始录制后才有。
    run.hub.bind({ sessionId: input.sessionId, snapshot: () => progress.recorder?.snapshot() });
    return { input, observability };
  }

  /** ② 绑工作区、装 agent,并把「实际用了哪个模型」记进台账。 */
  private async assemble(run: ActiveRun, accepted: AcceptedRun): Promise<AssembledRun> {
    const input = await prepareRunWorkspace(this.preparation, accepted.input);
    const approvals = new RunApprovalChannel({
      approvals: this.deps.approvals,
      approvalPolicies: this.deps.approvalPolicies,
      runId: run.id,
      sessionId: input.sessionId,
      emit: run.emit
    });
    const observability = this.builder.createObservability({
      runId: run.id,
      sessionId: input.sessionId,
      enabled: accepted.observability.enabled,
      captureLevel: accepted.observability.captureContent
    });
    observability.recorder.record({
      agent: "main",
      kind: "run_started",
      payload: {
        requestedModel: input.modelId,
        ...(input.workspace !== undefined ? { workspaceId: input.workspace.id } : {})
      }
    });

    const runtime = await this.builder.assemble({
      runId: run.id,
      sessionId: input.sessionId,
      input,
      approvals,
      abortSignal: run.controller.signal,
      emit: run.emit
    }, observability);

    const resolvedModel = runtime.resolved.mainModel.qualifiedModelId;
    this.deps.runs.patchRouting(run.id, input.modelId, resolvedModel);
    observability.recorder.record({
      agent: "main",
      kind: "routing_resolved",
      payload: { requestedModel: input.modelId, resolvedModel }
    });
    return { ...runtime, input, approvals };
  }

  /**
   * ④ SSE 头发出后,错误只能从流里告知,不能再回 HTTP 状态码。
   * 断连只是少了一个观众:run 继续跑,pending 审批继续等人。
   */
  private openStream(run: ActiveRun, stream: RunEventStream, log: RunRequestLog, progress: RunProgress): void {
    stream.open();
    progress.streamOpened = true;
    run.hub.attach(stream, { replay: false });
    stream.onDisconnect(() => {
      run.hub.detach(stream);
      log.info({ runId: run.id }, "sse subscriber left; run continues detached");
    });
    run.emit({ type: "run_start", runId: run.id, sessionId: progress.sessionId! });
  }

  /** 从这里起 run 有了 assistant 消息:收尾以消息为准,成功时可以入队记忆提取。 */
  private startRecording(run: ActiveRun, assembled: AssembledRun, progress: RunProgress): AssistantMessageRecorder {
    const recorder = new AssistantMessageRecorder(this.deps.session, {
      sessionId: assembled.input.sessionId,
      runId: run.id,
      model: assembled.resolved.mainModel.qualifiedModelId,
      initialPosition: assembled.input.assistantPosition,
      lookupDecision: assembled.approvals.lookupApprovalDecision,
      lookupPlanReviewDecision: assembled.approvals.lookupPlanReviewDecision
    });
    progress.recorder = recorder;
    progress.extraction = assembled.extraction;
    return recorder;
  }

  /**
   * 写终态。成功、流式中失败、准备期失败都走这里。
   *
   * 最终 assistant 消息、终态、记忆提取入队在同一个事务里:崩溃时不会出现
   * 「消息落了但 run 还是 running」或「run 完成了但提取任务丢了」。
   * 台账的条件更新(只改 status=running 的行)保证终态只写一次。
   */
  private settle(run: ActiveRun, progress: RunProgress, error?: unknown) {
    const aborted = run.controller.signal.aborted;
    const { finishReason, enqueued } = this.deps.db.transaction(() => {
      const recorded = progress.recorder?.finish();
      const finishReason = recorded?.finishReason ?? (aborted ? "aborted" : "error");
      this.deps.runs.settle(run.id, {
        status: runStatusFor(finishReason),
        finishReason,
        ...terminalDetails(recorded, error, progress.failureLayer),
      });
      const enqueued = finishReason === "stop" && recorded !== undefined
        && this.enqueueExtraction(run, progress, recorded);
      return { finishReason, enqueued };
    });
    if (enqueued) this.deps.memoryAutomation?.wake();
    return finishReason;
  }

  private enqueueExtraction(run: ActiveRun, progress: RunProgress, recorded: RecordedAssistantRun): boolean {
    const { extraction, sessionId, userMessageId } = progress;
    if (!extraction || !sessionId || !userMessageId || !this.deps.memoryAutomation) return false;
    try {
      return this.deps.memoryAutomation.enqueue({
        sourceRunId: run.id,
        sessionId,
        ...(extraction.workspaceId ? { workspaceId: extraction.workspaceId } : {}),
        sourceUserMessageId: userMessageId,
        sourceAssistantMessageId: recorded.assistantMessageId,
        modelId: extraction.modelId,
        mode: extraction.mode
      });
    } catch (error) {
      // 记忆提取是附加能力:入队失败绝不能把一次成功的 run 变成失败。
      this.deps.logger.warn({ err: error, runId: run.id }, "could not enqueue memory extraction");
      return false;
    }
  }

  private fail(run: ActiveRun, progress: RunProgress, error: unknown, log: RunRequestLog): RunOutcome {
    const aborted = run.controller.signal.aborted;
    log.error({ err: error, runId: run.id }, "agent run failed");

    progress.recorder?.fail(error, aborted);
    if (progress.sessionId) this.settle(run, progress, error);

    if (!progress.streamOpened) {
      return {
        kind: "rejected",
        error,
        runId: run.id,
        ...(progress.sessionId ? { sessionId: progress.sessionId } : {})
      };
    }
    run.emit({ type: "error", message: toErrorMessage(error) });
    run.emit({ type: "end", finishReason: aborted ? "aborted" : "error" });
    return { kind: "streamed" };
  }
}

const duplicateOf = (existing: RunRecord): RunOutcome => ({
  kind: "duplicate",
  runId: existing.id,
  sessionId: existing.sessionId,
  status: existing.status
});

/**
 * 终态里 status/finishReason 之外的细节。
 * 有 assistant 消息时以消息为准;还没开始流式就失败时,记抛错的那一层。
 */
const terminalDetails = (
  recorded: RecordedAssistantRun | undefined,
  error: unknown,
  failureLayer: RunFailureLayer | undefined
) => {
  if (recorded) {
    return {
      assistantMessageId: recorded.assistantMessageId,
      ...(recorded.usage ? { usage: recorded.usage } : {}),
      ...(recorded.streamError ? { error: recorded.streamError } : {}),
      ...(recorded.failureLayer ? { failureLayer: recorded.failureLayer } : {}),
    };
  }
  return {
    ...(error !== undefined ? { error: toErrorMessage(error) } : {}),
    failureLayer: failureLayer ?? "unknown",
  };
};
