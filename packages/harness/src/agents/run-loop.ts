import {
  stepCountIs,
  streamText,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from "ai";
import {
  planGateInstructions,
  toToolSet,
} from "../tools/index.js";
import { buildToolPipeline } from "../tools/tool-pipeline.js";
import { buildAgentSystemPrompt } from "../prompts/prompt-builder.js";
import {
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  readTokenUsage,
  type AgentObserver,
  type AgentTelemetryEvent,
  type ContextCompactionReason,
  type LoopTransitionReason,
  type TokenUsage,
} from "./observer.js";
import {
  resolveContextWindowPolicy,
  type ContextWindowPolicy,
} from "../context/policy.js";
import {
  estimateMessagesTokens,
  type RuntimeCompactResult,
} from "../context/runtime-compact.js";
import { coalesceTextDeltas } from "./coalesce-stream.js";
import {
  resolveToolExposure,
  TOOL_COUNT_SAFETY_LIMIT,
} from "./tool-safety-net.js";
import {
  createPrepareStep,
} from "./context-strategy.js";
import { mapStreamPart, type ToolCallClock } from "./stream-part-mapper.js";
import {
  abortInFlightToolCalls,
  finishRun,
  isAbortError,
  type FinishReason,
} from "./finish-run.js";
import {
  buildMaxOutputRecovery,
  planReactiveRecovery,
  shouldRecoverMaxOutput,
} from "./recovery-policy.js";
import type {
  CreateAgentOptions,
  AgentRunInput,
  AgentRunResult,
  AgentStreamEvent,
  AgentToolCallResult,
  Agent as AgentInterface,
} from "./types.js";

const TOOL_DISCOVERY_NOTICE: SystemModelMessage = {
  role: "system",
  content:
    "Tool discovery mode is active: only core tools are enabled initially. " +
    "Use `tool_search` to find and activate additional tools; activated tools become callable from the next model step.",
};

const formatContext = (
  context: Record<string, unknown> | undefined,
): string | undefined =>
  !context || Object.keys(context).length === 0
    ? undefined
    : `Additional context:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``;

const resolveSystemMessage = (
  prompt: string | SystemModelMessage | undefined,
): SystemModelMessage =>
  typeof prompt === "object" && prompt !== null && prompt.role === "system"
    ? prompt
    : {
      role: "system",
      content:
        (typeof prompt === "string" ? prompt : undefined)?.trim() ||
        buildAgentSystemPrompt(),
    };

export type RunLoopOptions = CreateAgentOptions;

class RunLoopAgent implements AgentInterface {
  private readonly systemMessage: SystemModelMessage;
  private readonly maxSteps: number;
  private readonly observer: AgentObserver | undefined;
  private readonly contextPolicy: ContextWindowPolicy;

  constructor(private readonly options: RunLoopOptions) {
    this.systemMessage = resolveSystemMessage(options.systemPrompt);
    this.maxSteps = options.maxSteps ?? 5;
    this.observer = options.observer;
    this.contextPolicy = resolveContextWindowPolicy(options.contextPolicy);
  }

  private emit(event: AgentTelemetryEvent): void {
    try {
      this.observer?.(event);
    } catch {
    }
  }

  private emitCompaction(
    step: number,
    reason: ContextCompactionReason,
    result: RuntimeCompactResult,
  ): void {
    this.emit({
      type: "context_compacted",
      step,
      reason,
      messageCountBefore: result.messageCountBefore,
      messageCountAfter: result.messageCountAfter,
      estimatedTokensBefore: result.estimatedTokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter,
    });
  }

  private emitTransition(
    step: number,
    reason: LoopTransitionReason,
    attempt?: number,
  ): void {
    this.emit({
      type: "loop_transition",
      step,
      reason,
      ...(attempt !== undefined ? { attempt } : {}),
    });
  }

  private buildMessages(input: AgentRunInput): {
    readonly messages: ModelMessage[];
    readonly prefixMessageCount: number;
  } {
    const context = formatContext(input.context);
    return {
      messages: [
        ...(context ? [{ role: "user", content: context } as ModelMessage] : []),
        ...input.messages,
      ],
      // Only the synthetic per-run context is immutable. Session history must
      // remain eligible for compaction, including on the first model step.
      prefixMessageCount: context ? 1 : 0,
    };
  }

  async invoke(input: AgentRunInput): Promise<AgentRunResult> {
    let result: AgentRunResult | undefined;
    for await (const event of this.run(input)) {
      if (event.type === "finish") {
        result = {
          text: event.text,
          toolCalls: event.toolCalls as AgentToolCallResult[],
        };
      }
    }
    if (!result) throw new Error("Agent finished without a result.");
    return result;
  }

  async *stream(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
    try {
      yield* coalesceTextDeltas(this.run(input));
    } catch (error) {
      if (!isAbortError(error)) {
        yield {
          type: "error",
          message: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  }

  private async *run(input: AgentRunInput): AsyncGenerator<AgentStreamEvent> {
    const runStart = Date.now();
    const pipeline = buildToolPipeline({
      ...this.options,
      onToolExecution: input.onToolExecution,
      tools: [...(this.options.tools ?? []), ...(input.additionalTools ?? [])],
    });
    try {
      const resolvedTools = new Map(pipeline.tools.map(tool => [tool.name, tool]));
      const { toolDiscovery, toolTiming } = pipeline;
      const exposure = resolveToolExposure(
        resolvedTools,
        input.activeToolNames,
        toolDiscovery,
        input.preferredToolNames,
      );
      if (exposure.degraded) {
        this.emit({
          type: "tool_count_degraded",
          totalCount: exposure.totalCount,
          keptCount: exposure.keptCount,
          limit: TOOL_COUNT_SAFETY_LIMIT,
        });
      }
      const toolSet: ToolSet = toToolSet([...resolvedTools.values()]);
      const maxSteps = input.maxSteps ?? this.maxSteps;
      const clock: ToolCallClock = new Map();
      const toolCalls: AgentToolCallResult[] = [];

      const initial = this.buildMessages(input);
      let messages = initial.messages;
      const fixedInstructions = messages.filter(
        (message): message is SystemModelMessage => message.role === "system",
      );
      messages = messages.filter(message => message.role !== "system");
      const prefixMessageCount = initial.prefixMessageCount;
      let stepsUsed = 0;
      let recoveries = 0;
      let hasCompactedReactively = false;
      let continuedText = "";
      let totalTokens: TokenUsage = ZERO_TOKEN_USAGE;
      let stepStartTime = runStart;
      let lastStepInputTokens: number | undefined;

      const turnStartTime = runStart;
      const attemptByStep = new Map<number, number>();
      let currentStepAttempt = 1;
      let firstTokenEmitted = false;
      let streamingStepIndex = 0;


      const finish = (finishReason: FinishReason, text: string) => finishRun({
        text, toolCalls, finishReason, usage: totalTokens, runStart, stepsUsed, maxSteps,
        turn: { index: 0, startTime: turnStartTime }, emit: event => this.emit(event),
      });

      this.emit({ type: "agent_run_start" });
      this.emit({ type: "turn_started", turnIndex: 0 });

      for (; ;) {
        if (maxSteps - stepsUsed <= 0) {
          this.emitTransition(stepsUsed, "max_steps");
          yield finish("max-steps", continuedText);
          return;
        }

        const hoistedSystemMessages = messages.filter(
          (message): message is SystemModelMessage => message.role === "system",
        );
        const streamMessages =
          hoistedSystemMessages.length > 0
            ? messages.filter((message) => message.role !== "system")
            : messages;

        const prepareStep = createPrepareStep({
          policy: this.contextPolicy,
          systemPrompt: this.systemMessage,
          prefixMessageCount,
          onPreparedMessages: (prepared) => { messages = prepared; },
          onCompacted: (result) => {
            this.emitCompaction(stepsUsed, "proactive_loop_compact", result);
            this.emitTransition(stepsUsed, "proactive_loop_compact");
          },
          getLastStepInputTokens: () => lastStepInputTokens,
          getActiveTools: () =>
            toolDiscovery.activeTools() as
            | readonly (keyof ToolSet & string)[]
            | undefined,
          getExtraInstructions: () =>
            planGateInstructions(
              this.options.planGateState?.current() ?? { active: false },
            ),
          extraInstructions: [
            ...fixedInstructions,
            ...hoistedSystemMessages,
            ...(exposure.degraded ? [TOOL_DISCOVERY_NOTICE] : []),
          ],
        });

        const modelSpec = this.options.model as {
          readonly provider?: string;
          readonly modelId?: string;
        };
        this.emit({
          type: "request_snapshot",
          provider: modelSpec.provider ?? "unknown",
          modelId: modelSpec.modelId ?? "unknown",
          callSettings: {
            ...(this.options.callSettings?.temperature !== undefined
              ? { temperature: this.options.callSettings.temperature }
              : {}),
            ...(this.options.callSettings?.maxOutputTokens !== undefined
              ? { maxOutputTokens: this.options.callSettings.maxOutputTokens }
              : {}),
          },
          systemPrompt: this.systemMessage.content,
          tools: [...resolvedTools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
          })),
        });

        const result = streamText({
          model: this.options.model,
          messages: streamMessages,
          tools: toolSet,
          ...(exposure.activeTools !== undefined
            ? {
              activeTools: exposure.activeTools as readonly (keyof ToolSet &
                string)[],
            }
            : {}),
          stopWhen: [
            stepCountIs(1),
            () => this.options.planGateState?.shouldStopTurn() === true,
          ],
          prepareStep,
          ...(input.abortSignal !== undefined
            ? { abortSignal: input.abortSignal }
            : {}),
          ...(this.options.toolTimeout !== undefined
            ? { timeout: this.options.toolTimeout }
            : {}),
          ...(this.options.callSettings?.temperature !== undefined
            ? { temperature: this.options.callSettings.temperature }
            : {}),
          ...(this.options.callSettings?.maxOutputTokens !== undefined
            ? { maxOutputTokens: this.options.callSettings.maxOutputTokens }
            : {}),
          onStepStart: () => {
            stepStartTime = Date.now();
            const attempt = (attemptByStep.get(stepsUsed) ?? 0) + 1;
            attemptByStep.set(stepsUsed, attempt);
            currentStepAttempt = attempt;
            streamingStepIndex = stepsUsed;
            firstTokenEmitted = false;
            this.emit({ type: "step_started", step: stepsUsed, attempt });
            this.emit({ type: "llm_call_start", step: stepsUsed, attempt });
          },
          onError: () => {
          },
        });

        let text = "";
        let aborted = false;
        let streamError: unknown;

        try {
          for await (const part of result.stream) {
            if (input.abortSignal?.aborted) {
              aborted = true;
              break;
            }

            if (part.type === "start-step") {
              yield { type: "step-start", step: stepsUsed };
              continue;
            }

            if (
              !firstTokenEmitted &&
              (part.type === "text-delta" ||
                part.type === "reasoning-delta" ||
                part.type === "tool-input-start" ||
                part.type === "tool-call")
            ) {
              firstTokenEmitted = true;
              this.emit({
                type: "model_first_token",
                step: streamingStepIndex,
                attempt: currentStepAttempt,
                durationMs: Date.now() - stepStartTime,
              });
            }

            if (part.type === "finish-step") {
              this.emit({
                type: "model_call_completed",
                step: streamingStepIndex,
                attempt: currentStepAttempt,
              });
            }

            if (part.type === "text-delta") {
              text += part.text;
            }

            const mapped = mapStreamPart(part, clock, toolTiming);

            if (mapped.error !== undefined) {
              streamError = mapped.error;
              break;
            }
            if (mapped.aborted === true) {
              aborted = true;
              break;
            }

            if (mapped.toolCall !== undefined) {
              toolCalls.push(mapped.toolCall);
              this.emit({
                type: "tool_call_completed",
                step: stepsUsed,
                toolName: mapped.toolCall.toolName,
                toolCallId: mapped.toolCall.toolCallId ?? "",
                status: mapped.toolCall.status,
                durationMs: mapped.toolCall.durationMs ?? 0,
                output: mapped.toolCall.output,
                ...(mapped.toolCall.toolExecMs !== undefined
                  ? { toolExecMs: mapped.toolCall.toolExecMs }
                  : {}),
                ...(mapped.toolCall.approvalWaitMs !== undefined
                  ? { approvalWaitMs: mapped.toolCall.approvalWaitMs }
                  : {}),
                ...(mapped.toolCall.queueWaitMs !== undefined
                  ? { queueWaitMs: mapped.toolCall.queueWaitMs }
                  : {}),
                ...(mapped.toolCall.execAborted !== undefined
                  ? { execAborted: mapped.toolCall.execAborted }
                  : {}),
              });
            }

            if (mapped.event !== undefined) {
              if (mapped.event.type === "tool-call") {
                this.emit({
                  type: "tool_call_started",
                  step: stepsUsed,
                  toolName: mapped.event.toolName,
                  toolCallId: mapped.event.toolCallId,
                  input: mapped.event.input,
                });
              }
              yield mapped.event;
            }
          }
        } catch (error) {
          if (isAbortError(error)) {
            aborted = true;
          } else {
            streamError = error;
          }
        }

        if (streamError !== undefined) {
          const recovery = planReactiveRecovery({
            error: streamError,
            messages,
            prefixMessageCount,
            hasCompactedReactively,
          });
          const { errorMessage, compactCandidate } = recovery;
          if (compactCandidate && this.options.modelIdentity) {
            this.emit({
              type: "context_overflow",
              providerId: this.options.modelIdentity.providerId,
              modelId: this.options.modelIdentity.modelId,
              contextWindow: this.contextPolicy.contextWindow,
              observedTokens:
                lastStepInputTokens ?? estimateMessagesTokens(messages),
            });
          }
          const appliedCompaction = recovery.compaction;
          const retried = appliedCompaction !== undefined;
          if (appliedCompaction) {
            messages = appliedCompaction.messages;
            hasCompactedReactively = true;
          }
          this.emit({
            type: "model_call_failed",
            step: stepsUsed,
            attempt: currentStepAttempt,
            error: errorMessage,
            willRetry: retried,
          });
          if (retried && appliedCompaction) {
            this.emitCompaction(
              stepsUsed,
              "reactive_compact_retry",
              appliedCompaction,
            );
            this.emitTransition(stepsUsed, "reactive_compact_retry");
            continue;
          }
          this.emit({
            type: "agent_run_failed",
            error: errorMessage,
            failureLayer: compactCandidate ? "context" : "model",
          });
          this.emit({
            type: "turn_completed",
            turnIndex: 0,
            durationMs: Date.now() - turnStartTime,
            status: "error",
          });
          yield { type: "error", message: errorMessage, failureLayer: compactCandidate ? "context" : "model" };
          return;
        }

        if (aborted) {
          yield* abortInFlightToolCalls({
            clock,
            toolCalls,
            step: stepsUsed,
            emit: (event) => this.emit(event),
          });

          yield finish("aborted", continuedText + text);
          return;
        }

        const step = (await result.steps)[0];
        if (!step) throw new Error("Model stream ended without a completed step.");
        const stepUsage = readTokenUsage(step.usage);
        if (stepUsage) totalTokens = addTokenUsage(totalTokens, stepUsage);
        lastStepInputTokens = stepUsage && stepUsage.promptTokens > 0
          ? stepUsage.promptTokens : undefined;
        this.emit({
          type: "llm_call_end", step: stepsUsed,
          durationMs: Date.now() - stepStartTime,
          ...(stepUsage ? { tokenUsage: stepUsage } : {}),
          hasToolCalls: step.toolCalls.length > 0,
        });
        stepsUsed += 1;
        messages = [...messages, ...await result.responseMessages];
        const finishReason = await result.finishReason;

        if (this.options.planGateState?.shouldStopTurn() !== true &&
          step.toolCalls.length > 0 && step.toolResults.length === step.toolCalls.length) {
          continuedText += text;
          continue;
        }

        if (
          shouldRecoverMaxOutput({
            finishReason,
            recoveries,
            policy: this.contextPolicy,
          })
        ) {
          const recovery = buildMaxOutputRecovery({
            responseMessages: messages,
            continuedText,
            text,
            recoveries,
          });
          continuedText = recovery.continuedText;
          messages = recovery.messages;
          recoveries = recovery.recoveries;
          this.emitTransition(
            stepsUsed,
            "max_output_tokens_recovery",
            recoveries,
          );
          continue;
        }

        const isMaxSteps = stepsUsed >= maxSteps;
        if (isMaxSteps) {
          this.emitTransition(stepsUsed, "max_steps");
        }
        yield finish(isMaxSteps ? "max-steps" : "stop", continuedText + text);
        return;
      }
    } finally {
      await pipeline.drain();
    }
  }

}

export const createRunLoopAgent = (options: RunLoopOptions): AgentInterface => {
  return new RunLoopAgent(options);
};
