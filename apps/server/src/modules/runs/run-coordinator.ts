import { recordToolExecution } from "./tool-operations.js";
import { randomUUID } from "node:crypto";

import type { AgentObserver, Skill } from "@eva/harness";
import { toErrorMessage, type RunStreamEvent } from "@eva/shared";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import type { AgentFactory } from "./agent-factory.js";
import type {
  ApprovalGateway,
  ApprovalPolicyStore,
} from "../approvals/index.js";
import type { McpRegistry } from "../mcp/index.js";
import type { DrizzleMessageRepository } from "../sessions/index.js";
import type { DrizzlePlanRepository } from "../plan-gate/index.js";
import type { DrizzleRunRepository } from "./run-repository.js";
import type { DrizzleSessionRepository } from "../sessions/index.js";
import type { RunRegistry } from "./run-registry.js";
import type { SessionService } from "../sessions/index.js";
import { loadAppSettings } from "../settings/index.js";
import type { WorkspaceStore } from "../workspaces/index.js";
import type { RunEventStream } from "../../transports/sse/event-stream.js";
import { runRequestSchema } from "../../types/runs.js";
import { AssistantMessageRecorder } from "./assistant-message-recorder.js";
import { RunApprovalChannel } from "./run-approval-channel.js";
import { runStatusFor } from "./run-repository.js";
type RunFailurePhase = "routing" | "context";
import {
  prepareRunContext,
  prepareRunInput,
  prepareRunWorkspace,
  type RunPreparationDependencies
} from "./run-preparation.js";
import { RunRuntimeBuilder, type RunRuntimeScope } from "./run-runtime-builder.js";
import type { MemoryAutomationService } from "../memory/index.js";

export interface RunCoordinatorDependencies {
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

export class RunCoordinator {
  private readonly preparation: RunPreparationDependencies;
  private readonly builder: RunRuntimeBuilder;

  constructor(private readonly deps: RunCoordinatorDependencies) {
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
    let runRequest;
    try { runRequest = runRequestSchema.parse(body ?? {}); }
    catch (error) { return { kind: "rejected", error }; }
    const runId = runRequest.requestId ?? randomUUID();
    const existing = this.deps.runs.findById(runId);
    if (existing) return { kind: "duplicate", runId, sessionId: existing.sessionId, status: existing.status };
    const controller = this.deps.runRegistry.register(runId);
    const hub = this.deps.runRegistry.hubFor(runId)!;
    const emit = (event: RunStreamEvent) => hub.publish(event);
    let sessionId = "";
    let phase: RunFailurePhase | undefined;
    let streamOpened = false;
    let messageRecorder: AssistantMessageRecorder | undefined;
    let inputForExtraction: { readonly userMessageId: string } | undefined;
    let extractionContext: {
      readonly enabled: boolean;
      readonly mode: "review" | "automatic";
      readonly modelId: string;
      readonly workspaceId?: string | undefined;
    } | undefined;

    const finish = () => this.deps.db.transaction(() => {
      const recorded = messageRecorder?.finish();
      const finishReason = recorded?.finishReason ?? (controller.signal.aborted ? "aborted" : "error");
      this.deps.runs.settle(runId, {
        status: runStatusFor(finishReason), finishReason,
        ...(recorded ? { assistantMessageId: recorded.assistantMessageId } : {}),
        ...(recorded?.usage ? { usage: recorded.usage } : {}),
        ...(recorded?.streamError ? { error: recorded.streamError } : {}),
        ...(recorded?.failureLayer ? { failureLayer: recorded.failureLayer } : {}),
      });
      let extractionEnqueued = false;
      if (
        recorded
        && finishReason === "stop"
        && extractionContext?.enabled
        && inputForExtraction
        && this.deps.memoryAutomation
      ) {
        try {
          extractionEnqueued = this.deps.memoryAutomation.enqueue({
            sourceRunId: runId,
            sessionId,
            ...(extractionContext.workspaceId ? { workspaceId: extractionContext.workspaceId } : {}),
            sourceUserMessageId: inputForExtraction.userMessageId,
            sourceAssistantMessageId: recorded.assistantMessageId,
            modelId: extractionContext.modelId,
            mode: extractionContext.mode
          });
        } catch (error) {
          // Memory enrichment must never turn a successful user run into an error.
          this.deps.logger.warn({ err: error, runId }, "could not enqueue memory extraction");
        }
      }
      return { finishReason, extractionEnqueued };
    });
    try {

      const observabilitySettings = loadAppSettings(this.deps.db, this.deps.config).observability;
      let input = this.deps.db.transaction(() => {
        const input = prepareRunInput(this.preparation, runRequest, runId);
        this.deps.runs.start({
          id: runId, sessionId: input.sessionId, userMessageId: input.userMessageId,
          requestedModel: input.modelId, captureLevel: observabilitySettings.captureContent,
        });
        return input;
      });
      sessionId = input.sessionId;

      const approvals = new RunApprovalChannel({
        approvals: this.deps.approvals,
        approvalPolicies: this.deps.approvalPolicies,
        runId,
        sessionId,
        emit
      });

      phase = "routing";
      input = await prepareRunWorkspace(this.preparation, input);

      const runtimeScope: RunRuntimeScope = {
        runId,
        sessionId,
        input,
        approvals,
        captureLevel: observabilitySettings.captureContent,
        observabilityEnabled: observabilitySettings.enabled,
        abortSignal: controller.signal,
        emit
      };
      const observability = this.builder.createObservability(runtimeScope);
      const { recorder } = observability;

      recorder.record({
        agent: "main",
        kind: "run_started",
        payload: {
          requestedModel: input.modelId,
          ...(input.workspace !== undefined ? { workspaceId: input.workspace.id } : {})
        }
      });

      hub.bind({ sessionId, snapshot: () => undefined });

      const agentRuntime = await this.builder.buildAgent(
        runtimeScope,
        observability
      );
      const { resolved } = agentRuntime;
      inputForExtraction = input;
      extractionContext = {
        enabled: agentRuntime.memorySettings.enabled && agentRuntime.memorySettings.autoSummarize,
        mode: agentRuntime.memorySettings.autoSummarizeMode,
        modelId: resolved.toolModel.qualifiedModelId,
        ...(input.workspace ? { workspaceId: input.workspace.id } : {})
      };

      this.deps.runs.patchRouting(
        runId,
        input.modelId,
        resolved.mainModel.qualifiedModelId
      );
      recorder.record({
        agent: "main",
        kind: "routing_resolved",
        payload: {
          requestedModel: input.modelId,
          resolvedModel: resolved.mainModel.qualifiedModelId
        }
      });
      phase = "context";

      const runContext = await prepareRunContext(this.preparation, input, resolved);

      controller.signal.throwIfAborted();
      this.deps.memoryAutomation?.commitRetrieval(runId, agentRuntime.memoryRetrieval);
      phase = undefined;

      stream.open();
      streamOpened = true;
      void hub.attach(stream, { replay: false });
      emit({ type: "run_start", runId, sessionId });

      const subagents = this.builder.buildSubagents(runtimeScope, agentRuntime, observability.bridge);

      stream.onDisconnect(() => {
        hub.detach(stream);
        log.info({ runId }, "sse subscriber left; run continues detached");
      });

      messageRecorder = new AssistantMessageRecorder(this.deps.session, {
        sessionId,
        runId,
        model: resolved.mainModel.qualifiedModelId,
        initialPosition: input.assistantPosition,
        lookupDecision: approvals.lookupApprovalDecision,
        lookupPlanReviewDecision: approvals.lookupPlanReviewDecision
      });

      hub.bind({ sessionId, snapshot: () => messageRecorder!.snapshot() });

      let lastCheckpointAt = Date.now();
      for await (const event of resolved.agent.stream({
        messages: runContext.modelMessages,
        onToolExecution: recordToolExecution(this.deps.db, runId, "main"),
        abortSignal: controller.signal,
        additionalTools: [...subagents.tools],
      })) {
        messageRecorder.push(event);
        if (event.type === "tool-call" || event.type === "tool-result" || event.type === "step-start" || Date.now() - lastCheckpointAt >= 1000) {
          messageRecorder.checkpoint();
          lastCheckpointAt = Date.now();
        }
        emit(event);
      }

      const { finishReason, extractionEnqueued } = finish();
      if (extractionEnqueued) this.deps.memoryAutomation?.wake();
      emit({ type: "end", finishReason });
      return { kind: "streamed" };
    } catch (error) {
      log.error({ err: error, runId }, "agent run failed");
      if (messageRecorder) {
        messageRecorder.fail(error, controller.signal.aborted);
        const { extractionEnqueued } = finish();
        if (extractionEnqueued) this.deps.memoryAutomation?.wake();
      } else if (sessionId) {
        this.deps.runs.settle(runId, {
          status: controller.signal.aborted ? "aborted" : "error",
          finishReason: controller.signal.aborted ? "aborted" : "error",
          error: toErrorMessage(error), failureLayer: phase ?? "unknown",
        });
      }
      if (!streamOpened) return { kind: "rejected", error, runId, ...(sessionId ? { sessionId } : {}) };
      emit({ type: "error", message: toErrorMessage(error) });
      emit({ type: "end", finishReason: controller.signal.aborted ? "aborted" : "error" });
      return { kind: "streamed" };
    } finally {
      this.deps.approvals.cancelByRun(runId);
      this.deps.runRegistry.unregister(runId);
    }
  }
}
