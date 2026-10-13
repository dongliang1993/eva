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
  addTokenUsage,
  readTokenUsage,
  toContractTokenUsage,
  ZERO_TOKEN_USAGE,
  type TokenUsage,
} from "../query/usage.js";
import {
  resolveContextWindowPolicy,
  type ContextWindowPolicy,
} from "../context/policy.js";
import { estimateMessagesTokens } from "../context/runtime-compact.js";
import {
  resolveToolExposure,
  TOOL_COUNT_SAFETY_LIMIT,
} from "../tools/tool-safety-net.js";
import { createPrepareStep } from "../context/context-strategy.js";
import {
  buildMaxOutputRecovery,
  planReactiveRecovery,
  shouldRecoverMaxOutput,
} from "../context/recovery-policy.js";
import {
  compactBoundaryMessage,
  resultMessage,
  toToolTimingRecord,
} from "../query/messages.js";
import { finishTurn, runTurnStream, type ToolResultOnStream } from "../query/turn.js";
import type { HarnessMessage } from "../query/types.js";
import type { AgentRunInput, CreateAgentOptions } from "./types.js";
import { coalesceStreamEvents } from "../query/coalesce-stream.js";
import { isAbortError } from "../query/finish-run.js";
import type { ToolTimingMutable } from "../query/tool-call.js";
import { resolveFinalText } from "../query/finish-run.js";
import { abortInFlightMessages } from "../query/abort-in-flight.js";

const TOOL_DISCOVERY_NOTICE: SystemModelMessage = {
  role: "system",
  content:
    "Tool discovery mode is active: only core tools are enabled initially. " +
    "Use `tool_search` to find and activate additional tools; activated tools become callable from the next model step.",
};

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

/**
 * turn 循环本体(query() 的引擎)。输出只有 HarnessMessage 一条流:
 * 轨迹页的 run_events 由 server 的 run-trajectory 从消息推(fire-and-forget
 * observer 已删);compact_boundary 在 compact 发生点产出。
 */
class RunLoopAgent {
  private readonly systemMessage: SystemModelMessage;
  private readonly maxSteps: number;
  private readonly contextPolicy: ContextWindowPolicy;

  constructor(private readonly options: RunLoopOptions) {
    this.systemMessage = resolveSystemMessage(options.systemPrompt);
    this.maxSteps = options.maxSteps ?? 5;
    this.contextPolicy = resolveContextWindowPolicy(options.contextPolicy);
  }

  private buildMessages(input: AgentRunInput): {
    readonly messages: ModelMessage[];
    readonly prefixMessageCount: number;
  } {
    return {
      messages: [...input.messages],
      // 会话历史从第一条起就参与 compact;没有合成前缀。
      prefixMessageCount: 0,
    };
  }

  /** 消费流取 result(测试辅助;invoke 已删 —— 生产调用方只有 stream)。 */
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
      // server 注册的 hooks(权限/台账)在这条链上。
      ...(input.hooks !== undefined ? { hooks: input.hooks } : {}),
      tools: [...(this.options.tools ?? []), ...(input.additionalTools ?? [])],
      ...(input.agentID !== undefined ? { agentID: input.agentID } : {}),
    });
    try {
      const { toolDiscovery, catalog: resolvedTools } = pipeline;
      const exposure = resolveToolExposure(resolvedTools, toolDiscovery);
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

      // compact 发生点收集器:每次循环开头先冲掉上一圈内发生的 compact_boundary。
      const compacted: HarnessMessage[] = [];

      for (; ;) {
        // 上一圈的 compact 在本圈消息前发出(压缩发生在 prepareStep,即调模型之前)。
        for (const message of compacted.splice(0)) yield message;
        if (maxSteps - stepsUsed <= 0) {
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
          // compact 发生点:消息流的 compact_boundary 在这里产出(server 从它翻 context_compacted)。
          onCompacted: (result) => {
            compacted.push(compactBoundaryMessage({
              trigger: "auto",
              preTokens: result.estimatedTokensBefore,
              postTokens: result.estimatedTokensAfter,
              preMessages: result.messageCountBefore,
              postMessages: result.messageCountAfter,
              parentToolUseID: null,
            }));
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

        // request_snapshot 事件已删:轨迹页的 request_snapshot 由 server 从
        // system/init(system_prompt/tools/model)推,不再需要模型侧自报。

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
          },
          // 错误已经由 stream 的 error part 处理(runTurnStream 抛给 catch)。
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
          includePartialMessages: input.includePartialMessages ?? true,
          stream: abortableStream,
          turnStartedAt: stepStartTime,
        });
        try {
          for await (const message of turnStream) {
            if (message.type === "stream_event" && message.event.type === "text_delta") {
              text += message.event.text;
            }
            if (message.type === "assistant") {
              for (const part of message.message.content) {
                if (typeof part === "object" && part !== null && part.type === "tool-call") {
                  pendingToolCalls.set(part.toolCallId, part.toolName);
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
        }

        if (aborted) {
          // abort:已产出的消息在流里发过了;这里补在飞工具的取消结果,再 result。
          yield* abortInFlightMessages({
            timings: pipeline.timings,
            pendingToolCalls,
            step: stepsUsed,
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
          const appliedCompaction = recovery.compaction;
          if (appliedCompaction) {
            messages = appliedCompaction.messages;
            hasCompactedReactively = true;
            // reactive compact 也产 compact_boundary(trigger 区分,轨迹页 kind 相同)。
            compacted.push(compactBoundaryMessage({
              trigger: "overflow_retry",
              preTokens: appliedCompaction.estimatedTokensBefore,
              postTokens: appliedCompaction.estimatedTokensAfter,
              preMessages: appliedCompaction.messageCountBefore,
              postMessages: appliedCompaction.messageCountAfter,
              parentToolUseID: null,
            }));
            continue;
          }
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
          continue;
        }

        const isMaxSteps = stepsUsed >= maxSteps;
        const finalText = resolveFinalText(
          continuedText + text,
          isMaxSteps ? "max-steps" : "stop",
          maxSteps,
        );
        yield isMaxSteps
          ? resultMessage.failure({
            subtype: "error_max_turns",
            errors: [finalText],
            numTurns: stepsUsed,
            durationMs: Date.now() - runStart,
            usage: toContractTokenUsage(totalTokens),
            stopReason: finishReason,
            parentToolUseID: null,
          })
          : resultMessage.success({
            result: finalText,
            numTurns: stepsUsed,
            durationMs: Date.now() - runStart,
            usage: toContractTokenUsage(totalTokens),
            stopReason: finishReason,
            parentToolUseID: null,
          });
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

export const createRunLoopAgent = (options: RunLoopOptions): RunLoopAgent => {
  return new RunLoopAgent(options);
};
