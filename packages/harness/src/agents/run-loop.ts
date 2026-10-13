import {
  stepCountIs,
  streamText,
  type SystemModelMessage,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import type { ModelMessage, Tool } from "ai";
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
import {
  resolveToolExposure,
  TOOL_COUNT_SAFETY_LIMIT,
} from "./tool-safety-net.js";
import {
  createPrepareStep,
} from "./context-strategy.js";
import {
  buildMaxOutputRecovery,
  planReactiveRecovery,
  shouldRecoverMaxOutput,
} from "./recovery-policy.js";
import {
  resultMessage,
  toContractTokenUsage,
  toToolTimingRecord,
} from "../query/messages.js";
import { finishTurn, runTurnStream, type ToolResultOnStream } from "../query/turn.js";
import type { HarnessMessage } from "../query/types.js";
import type {
  Agent as AgentInterface,
  AgentRunInput,
  AgentRunResult,
  CreateAgentOptions,
} from "./types.js";
import { coalesceStreamEvents } from "./coalesce-stream.js";
import { isAbortError } from "./finish-run.js";
import type { ToolTimingMutable } from "../query/tool-call.js";
import { resolveFinalText } from "./finish-run.js";
import { abortInFlightMessages } from "./abort-in-flight.js";

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

  /** 消费流取 result(测试辅助;invoke 已删 —— 生产调用方只有 stream)。 */
  async collectResult(input: AgentRunInput): Promise<AgentRunResult> {
    let result: AgentRunResult | undefined;
    for await (const message of this.run(input)) {
      if (message.type === "result" && message.subtype === "success") {
        result = { text: message.result, toolCalls: [] };
      }
    }
    if (!result) throw new Error("Agent finished without a result.");
    return result;
  }

  async *stream(input: AgentRunInput): AsyncGenerator<HarnessMessage> {
    try {
      // text/reasoning 的 stream_event 合并窗口;其余消息原样透传。
      yield* coalesceStreamEvents(this.run(input));
    } catch (error) {
      if (!isAbortError(error)) {
        yield resultMessage.failure({
          subtype: "error_during_execution",
          errors: [error instanceof Error ? error.message : "Unknown error"],
          numTurns: 0,
          durationMs: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          stopReason: null,
          parentToolUseID: null,
        });
      }
    }
  }

  private async *run(input: AgentRunInput): AsyncGenerator<HarnessMessage> {
    const runStart = Date.now();
    const pipeline = buildToolPipeline({
      ...this.options,
      onToolExecution: input.onToolExecution,
      // server 注册的 hooks 优先于 onToolExecution 的翻译(同时给时二选一)。
      ...(input.hooks !== undefined ? { hooks: input.hooks } : {}),
      tools: [...(this.options.tools ?? []), ...(input.additionalTools ?? [])],
      ...(input.agentID !== undefined ? { agentID: input.agentID } : {}),
    });
    try {
      const { toolDiscovery, catalog: resolvedTools } = pipeline;
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
      const toolSet: Record<string, Tool> = pipeline.toolSet;
      const maxSteps = input.maxSteps ?? this.maxSteps;

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
      let streamingStepIndex = 0;

      this.emit({ type: "agent_run_start" });
      this.emit({ type: "turn_started", turnIndex: 0 });

      for (; ;) {
        if (maxSteps - stepsUsed <= 0) {
          this.emitTransition(stepsUsed, "max_steps");
          yield resultMessage.failure({
            subtype: "error_max_turns",
            errors: [resolveFinalText(continuedText, "max-steps", maxSteps)],
            numTurns: stepsUsed,
            durationMs: Date.now() - runStart,
            usage: toContractTokenUsage(totalTokens),
            stopReason: null,
            parentToolUseID: null,
          });
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
          getExtraInstructions: () => {
            const dynamic = this.options.dynamicInstructions?.() ?? [];
            return dynamic.map((content) => ({ role: "system" as const, content }));
          },
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
            () => pipeline.tookInterruptSignal(),
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
            this.emit({ type: "step_started", step: stepsUsed, attempt });
            this.emit({ type: "llm_call_start", step: stepsUsed, attempt });
          },
          onError: () => {
          },
        });

        let text = "";
        let aborted = false;
        let streamError: unknown;
        let turnToolResults: readonly ToolResultOnStream[] = [];
        let ttftMs: number | null = null;
        // 在飞台账(流可见性):tool-call 块已见、result 未见的调用。
        // 与 execute 是否开跑无关 —— AI SDK 可能在 abort 后跳过执行,
        // 但帧的前端已经收到 tool-call,必须有收口。
        const pendingToolCalls = new Map<string, string>();

        // 边翻边发:runTurnStream 逐消息产出,run-loop 逐条 yield ——
        // abort 发生在流的中间时,消费者在任一 yield 点都能叫停。
        const abortableStream = abortAwareStream(
          result.stream as AsyncIterable<TextStreamPart<ToolSet>>,
          input.abortSignal,
        );
        const turnStream = runTurnStream({
          turn: stepsUsed,
          parentToolUseID: null,
          includePartialMessages: true,
          stream: abortableStream,
          turnStartedAt: stepStartTime,
        });
        try {
          let firstTokenEmitted = false;
          for await (const message of turnStream) {
            if (message.type === "stream_event" && message.event.type === "text_delta") {
              text += message.event.text;
              if (!firstTokenEmitted) {
                firstTokenEmitted = true;
                this.emit({
                  type: "model_first_token",
                  step: streamingStepIndex,
                  attempt: currentStepAttempt,
                  durationMs: Date.now() - stepStartTime,
                });
              }
            }
            if (message.type === "assistant") {
              for (const part of message.message.content) {
                if (typeof part === "object" && part !== null && part.type === "tool-call") {
                  pendingToolCalls.set(part.toolCallId, part.toolName);
                  if (!firstTokenEmitted) {
                    firstTokenEmitted = true;
                    // TTFT 的判定与旧循环一致:首条 text/reasoning/tool-call 增量都算。
                    this.emit({
                      type: "model_first_token",
                      step: streamingStepIndex,
                      attempt: currentStepAttempt,
                      durationMs: Date.now() - stepStartTime,
                    });
                  }
                  // observer 双轨:tool_call_started(轨迹页骨架;T3 步骤 4 换 run-trajectory)。
                  this.emit({
                    type: "tool_call_started",
                    step: stepsUsed,
                    toolName: part.toolName,
                    toolCallId: part.toolCallId,
                    input: (part.input as Record<string, unknown>) ?? {},
                  });
                }
              }
            }
            yield message;
            // yield 恢复后 signal 已置位:流消费停在中间,收口走 aborted 路径。
            if (input.abortSignal?.aborted) {
              aborted = true;
              break;
            }
          }
          if (input.abortSignal?.aborted) {
            aborted = true;
          }
        } catch (error) {
          if (isAbortError(error)) {
            aborted = true;
          } else {
            streamError = error;
          }
        }
        // runTurnStream 的终局(toolResults/ttft)在生成器收尾取。
        const turnFinal = await turnStream.final();
        turnToolResults = turnFinal.toolResults;
        ttftMs = turnFinal.ttftMs;
        for (const result of turnToolResults) {
          pendingToolCalls.delete(result.toolCallId);
          // observer 双轨:tool_call_completed(与旧 mapper 的汇总同源)。
          this.emit({
            type: "tool_call_completed",
            step: stepsUsed,
            toolName: result.toolName,
            toolCallId: result.toolCallId,
            status: result.isError ? "error" : "success",
            output: result.outputText,
          });
        }
        this.emit({
          type: "model_call_completed",
          step: streamingStepIndex,
          attempt: currentStepAttempt,
        });

        if (aborted) {
          // abort:已产出的消息在流里发过了;这里补在飞工具的取消结果,再 result。
          yield* abortInFlightMessages({
            timings: pipeline.timings,
            pendingToolCalls,
            step: stepsUsed,
            emit: (event) => this.emit(event),
          });
          yield resultMessage.failure({
            subtype: "interrupted",
            // 契约 interrupted 只有 errors:本轮已产出的文本放第一条(frames 的 finish.text 读它)。
            errors: [continuedText + text],
            numTurns: stepsUsed,
            durationMs: Date.now() - runStart,
            usage: toContractTokenUsage(totalTokens),
            stopReason: null,
            parentToolUseID: null,
          });
          return;
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
          yield resultMessage.failure({
            subtype: "error_during_execution",
            errors: [errorMessage],
            ...(compactCandidate ? { failureLayer: "context" as const } : { failureLayer: "model" as const }),
            numTurns: stepsUsed,
            durationMs: Date.now() - runStart,
            usage: toContractTokenUsage(totalTokens),
            stopReason: null,
            parentToolUseID: null,
          });
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

        // 终局两条由 finishTurn 补(usage/stopReason 这时才有)。
        const toolTimingRecord = toToolTimingRecord(pipeline.timings);
        for (const message of finishTurn({
          turn: stepsUsed - 1,
          parentToolUseID: null,
          ttftMs,
          durationMs: Date.now() - stepStartTime,
          stopReason: finishReason,
          usage: toContractTokenUsage(stepUsage ?? ZERO_TOKEN_USAGE),
          toolResults: turnToolResults,
          toolTiming: toolTimingRecord,
        })) {
          yield message;
        }
        pipeline.timings.clear();

        if (pipeline.tookInterruptSignal() !== true &&
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
        const finalText = resolveFinalText(
          continuedText + text,
          isMaxSteps ? "max-steps" : "stop",
          maxSteps,
        );
        if (isMaxSteps) {
          // observer 双轨:assistant_message / agent_run_end / turn_completed(轨迹页)。
          this.emit({
            type: "assistant_message",
            text: finalText,
            toolCallCount: 0,
          });
          this.emit({
            type: "turn_completed",
            turnIndex: 0,
            durationMs: Date.now() - turnStartTime,
            status: "aborted",
          });
          this.emit({
            type: "agent_run_end",
            totalDurationMs: Date.now() - runStart,
            stepCount: stepsUsed,
            totalTokenUsage: totalTokens,
            toolCallCount: 0,
            failureLayer: "orchestration",
          });
          yield resultMessage.failure({
            subtype: "error_max_turns",
            errors: [finalText],
            numTurns: stepsUsed,
            durationMs: Date.now() - runStart,
            usage: toContractTokenUsage(totalTokens),
            stopReason: finishReason,
            parentToolUseID: null,
          });
        } else {
          this.emit({
            type: "assistant_message",
            text: finalText,
            toolCallCount: 0,
          });
          this.emit({
            type: "turn_completed",
            turnIndex: 0,
            durationMs: Date.now() - turnStartTime,
            status: "completed",
          });
          this.emit({
            type: "agent_run_end",
            totalDurationMs: Date.now() - runStart,
            stepCount: stepsUsed,
            totalTokenUsage: totalTokens,
            toolCallCount: 0,
          });
          yield resultMessage.success({
            result: finalText,
            numTurns: stepsUsed,
            durationMs: Date.now() - runStart,
            usage: toContractTokenUsage(totalTokens),
            stopReason: finishReason,
            parentToolUseID: null,
          });
        }
        return;
      }
    } finally {
      await pipeline.drain();
    }
  }

}

/**
 * 包一层 abort 感知:signal 置位后底层流不再被拉取(下一次 next() 直接 done)。
 * runTurn 不认识 abort part —— 它只翻译;「该停了」由这层表达。
 */
const abortAwareStream = <T>(
  stream: AsyncIterable<T>,
  signal: AbortSignal | undefined,
): AsyncIterable<T> => ({
  [Symbol.asyncIterator]() {
    const iterator = stream[Symbol.asyncIterator]();
    return {
      next: async () => {
        if (signal?.aborted) {
          return { done: true, value: undefined } as IteratorResult<T>;
        }
        return iterator.next();
      },
      return: (value) => (iterator.return ? iterator.return(value) : Promise.resolve({ done: true, value })),
      throw: (reason) => (iterator.throw ? iterator.throw(reason) : Promise.reject(reason)),
    };
  },
});

export const createRunLoopAgent = (options: RunLoopOptions): AgentInterface => {
  return new RunLoopAgent(options);
};
