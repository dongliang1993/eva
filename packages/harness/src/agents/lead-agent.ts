import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet
} from "ai";
import type { StreamToolCallSummary, StreamTokenUsage } from "@eva/shared";

import type { AgentTool } from "../tools.js";
import { toToolSet } from "../tools.js";
import { buildAgentSystemPrompt } from "../prompts/prompt-builder.js";
import {
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  type AgentObserver,
  type AgentTelemetryEvent,
  type ContextCompactionReason,
  type LoopTransitionReason,
  type TokenUsage
} from "./observer.js";
import {
  resolveContextWindowPolicy,
  type ContextWindowPolicy,
  type ContextWindowPolicyOptions
} from "../context/policy.js";
import { isReactiveCompactCandidateError } from "../models/errors.js";
import {
  applyReactiveLoopCompactWithStats,
  type RuntimeCompactResult
} from "../context/runtime-compact.js";
import { coalesceTextDeltas } from "./coalesce-stream.js";
import {
  createPrepareStep,
  MAX_OUTPUT_CONTINUATION_MESSAGE,
  shouldContinueForMaxOutput
} from "./context-strategy.js";
import { mapStreamPart, type ToolCallClock } from "./stream-part-mapper.js";
import type {
  AgentCallSettings,
  AgentRunInput,
  AgentRunResult,
  AgentStreamEvent,
  AgentToolCallResult,
  Agent
} from "./types.js";

type FinishReason = "stop" | "aborted" | "error" | "max-steps";

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const toStreamTokenUsage = (u: TokenUsage): StreamTokenUsage => ({
  inputTokens: u.promptTokens,
  outputTokens: u.completionTokens,
  totalTokens: u.totalTokens
});

const toStreamToolCallSummary = (tc: AgentToolCallResult): StreamToolCallSummary => ({
  toolName: tc.toolName,
  toolCallId: tc.toolCallId ?? "",
  args: tc.args,
  output: tc.output,
  status: tc.status,
  ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {})
});

const formatContext = (context: Record<string, unknown> | undefined): string | undefined =>
  !context || Object.keys(context).length === 0
    ? undefined
    : `Additional context:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``;

const readTokenUsage = (u: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
} | undefined): TokenUsage | undefined => {
  if (!u) return undefined;
  const promptTokens = u.inputTokens ?? 0;
  const completionTokens = u.outputTokens ?? 0;
  const totalTokens = u.totalTokens ?? promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return undefined;
  return { promptTokens, completionTokens, totalTokens };
};

const resolveSystemMessage = (prompt: string | SystemModelMessage | undefined): SystemModelMessage =>
  typeof prompt === "object" && prompt !== null && prompt.role === "system"
    ? prompt
    : { role: "system", content: (typeof prompt === "string" ? prompt : undefined)?.trim() || buildAgentSystemPrompt() };

/**
 * 终态文本兜底(与重构前逐字一致)。max-steps 给固定兜底;否则累计文本为空时给空响应。
 * 注意:行为变化 —— 老代码按"本步既无文本也无 tool call"判空响应,新代码按"整个 run
 * 累计文本为空"判。后者更准确(用户看到的确实是空回复),commit 正文已说明。
 */
const finalText = (accumulated: string, isMaxSteps: boolean): string =>
  isMaxSteps
    ? "The agent reached the maximum tool-calling steps without producing a final answer."
    : (accumulated.trim() || "The model returned an empty response.");

export interface LeadAgentOptions {
  model: LanguageModel;
  tools?: AgentTool[];
  systemPrompt?: string | SystemModelMessage;
  maxSteps?: number;
  observer?: AgentObserver;
  contextPolicy?: ContextWindowPolicyOptions;
  callSettings?: AgentCallSettings;
}

export class LeadAgent implements Agent {
  private readonly toolsByName: Map<string, AgentTool>;
  private readonly systemMessage: SystemModelMessage;
  private readonly maxSteps: number;
  private readonly observer: AgentObserver | undefined;
  private readonly contextPolicy: ContextWindowPolicy;

  constructor(private readonly options: LeadAgentOptions) {
    this.toolsByName = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
    this.systemMessage = resolveSystemMessage(options.systemPrompt);
    this.maxSteps = options.maxSteps ?? 5;
    this.observer = options.observer;
    this.contextPolicy = resolveContextWindowPolicy(options.contextPolicy);
  }

  private emit(event: AgentTelemetryEvent): void {
    try {
      this.observer?.(event);
    } catch {
      // Observer errors must never break the agent loop
    }
  }

  private emitCompaction(step: number, reason: ContextCompactionReason, result: RuntimeCompactResult): void {
    this.emit({
      type: "context_compacted",
      step,
      reason,
      messageCountBefore: result.messageCountBefore,
      messageCountAfter: result.messageCountAfter,
      estimatedTokensBefore: result.estimatedTokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter
    });
  }

  private emitTransition(step: number, reason: LoopTransitionReason, attempt?: number): void {
    this.emit({ type: "loop_transition", step, reason, ...(attempt !== undefined ? { attempt } : {}) });
  }

  // messages 不含 system prompt —— 它由 createPrepareStep 作为 instructions 第一条注入
  // (streamText 顶层 messages 不允许 system 角色)。prefixMessageCount 只算 context 消息条数。
  private buildMessages(input: AgentRunInput): ModelMessage[] {
    const context = formatContext(input.context);
    return [...(context ? [{ role: "user", content: context } as ModelMessage] : []), ...input.messages];
  }

  private resolveTools(input: AgentRunInput): Map<string, AgentTool> {
    if (!input.additionalTools || input.additionalTools.length === 0) return this.toolsByName;
    const merged = new Map(this.toolsByName);
    for (const tool of input.additionalTools) merged.set(tool.name, tool);
    return merged;
  }

  async invoke(input: AgentRunInput): Promise<AgentRunResult> {
    let result: AgentRunResult | undefined;
    for await (const event of this.run(input)) {
      if (event.type === "finish") {
        result = { text: event.text, toolCalls: event.toolCalls as AgentToolCallResult[] };
      }
    }
    if (!result) throw new Error("Agent finished without a result.");
    return result;
  }

  async *stream(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
    try {
      yield* coalesceTextDeltas(this.run(input));
    } catch (error) {
      // abort: run() 已 yield finish(aborted);SDK 在 yield 前抛 AbortError 时这里静默收尾。
      if (!isAbortError(error)) {
        yield { type: "error", message: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  }

  private async *run(input: AgentRunInput): AsyncGenerator<AgentStreamEvent> {
    const runStart = Date.now();
    const toolSet: ToolSet = toToolSet([...this.resolveTools(input).values()]);
    const maxSteps = input.maxSteps ?? this.maxSteps;
    const clock: ToolCallClock = new Map();
    const toolCalls: AgentToolCallResult[] = [];

    let messages = this.buildMessages(input);
    const prefixMessageCount = messages.length;
    let stepsUsed = 0;
    let recoveries = 0;
    let hasCompactedReactively = false;
    let continuedText = "";
    let totalTokens: TokenUsage = ZERO_TOKEN_USAGE;
    let stepStartTime = runStart;

    this.emit({ type: "agent_run_start" });

    // 外层 restart:只有 max-output 续写与 reactive compact 会走到第二圈。
    for (;;) {
      // step 预算耗尽 → 直接 max-steps 终态,不再发起调用。
      if (maxSteps - stepsUsed <= 0) {
        yield this.finish(continuedText, toolCalls, "max-steps", totalTokens, runStart, stepsUsed);
        return;
      }

      const prepareStep = createPrepareStep({
        policy: this.contextPolicy,
        systemPrompt: this.systemMessage,
        prefixMessageCount,
        onCompacted: (result) => {
          this.emitCompaction(stepsUsed, "proactive_loop_compact", result);
          this.emitTransition(stepsUsed, "proactive_loop_compact");
        }
      });

      const result = streamText({
        model: this.options.model,
        messages,
        tools: toolSet,
        stopWhen: stepCountIs(maxSteps - stepsUsed),
        prepareStep,
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
        ...(this.options.callSettings?.temperature !== undefined
          ? { temperature: this.options.callSettings.temperature } : {}),
        ...(this.options.callSettings?.maxOutputTokens !== undefined
          ? { maxOutputTokens: this.options.callSettings.maxOutputTokens } : {}),
        onStepStart: () => {
          stepStartTime = Date.now();
          this.emit({ type: "llm_call_start", step: stepsUsed });
        },
        onStepEnd: ({ usage, toolCalls: stepToolCalls }) => {
          const stepIndex = stepsUsed;
          stepsUsed += 1;
          const stepUsage = readTokenUsage(usage);
          if (stepUsage) totalTokens = addTokenUsage(totalTokens, stepUsage);
          this.emit({
            type: "llm_call_end",
            step: stepIndex,
            durationMs: Date.now() - stepStartTime,
            ...(stepUsage !== undefined ? { tokenUsage: stepUsage } : {}),
            hasToolCalls: stepToolCalls.length > 0
          });
        },
        onError: () => {
          // 错误以 'error' part 出现在 stream 里,这里只防 unhandled rejection。
        }
      });

      let text = "";
      let aborted = false;
      let streamError: unknown;

      try {
        for await (const part of result.stream) {
          // SDK 不保证对忽略 abortSignal 的 provider 流强制中断(尤其本地/mock 流),
          // 每个 part 消费前显式检查一次,确保 abort 确定性生效。
          if (input.abortSignal?.aborted) {
            aborted = true;
            break;
          }

          if (part.type === "start-step") {
            yield { type: "step-start", step: stepsUsed };
            continue;
          }

          if (part.type === "text-delta") {
            text += part.text;
          }

          const mapped = mapStreamPart(part, clock);

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
              durationMs: mapped.toolCall.durationMs ?? 0
            });
          }

          if (mapped.event !== undefined) {
            // tool-call 事件补一个 tool_call_initiated 观测点(mapStreamPart 不打观测)。
            if (mapped.event.type === "tool-call") {
              this.emit({
                type: "tool_call_initiated",
                step: stepsUsed,
                toolName: mapped.event.toolName,
                toolCallId: mapped.event.toolCallId
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

      // ---- reactive compact:上下文溢出类错误,全程只重试一次 ----
      if (streamError !== undefined) {
        if (!hasCompactedReactively && isReactiveCompactCandidateError(streamError)) {
          const compaction = applyReactiveLoopCompactWithStats(messages, prefixMessageCount);
          if (compaction.changed) {
            messages = compaction.messages;
            hasCompactedReactively = true;
            this.emitCompaction(stepsUsed, "reactive_compact_retry", compaction);
            this.emitTransition(stepsUsed, "reactive_compact_retry");
            continue;
          }
        }
        // 错误终态:不 yield finish —— run() 抛出,由 stream() 转 error 事件(与重构前一致)。
        throw streamError;
      }

      if (aborted) {
        yield this.finish(continuedText + text, toolCalls, "aborted", totalTokens, runStart, stepsUsed);
        return;
      }

      const finishReason = await result.finishReason;

      // ---- max-output 续写 ----
      if (shouldContinueForMaxOutput(finishReason, recoveries, this.contextPolicy)) {
        continuedText += text;
        messages = [
          ...(await result.responseMessages),
          { role: "user", content: MAX_OUTPUT_CONTINUATION_MESSAGE } as ModelMessage
        ];
        recoveries += 1;
        this.emitTransition(stepsUsed, "max_output_tokens_recovery", recoveries);
        continue;
      }

      // ---- 终态:stop / max-steps / 空响应 ----
      const isMaxSteps = stepsUsed >= maxSteps;
      yield this.finish(
        continuedText + text,
        toolCalls,
        isMaxSteps ? "max-steps" : "stop",
        totalTokens,
        runStart,
        stepsUsed
      );
      return;
    }
  }

  private finish(
    text: string,
    toolCalls: readonly AgentToolCallResult[],
    finishReason: FinishReason,
    usage: TokenUsage,
    runStart: number,
    stepsUsed: number
  ): Extract<AgentStreamEvent, { type: "finish" }> {
    this.emit({
      type: "agent_run_end",
      totalDurationMs: Date.now() - runStart,
      stepCount: stepsUsed,
      totalTokenUsage: usage,
      toolCallCount: toolCalls.length
    });

    return {
      type: "finish",
      text: finalText(text, finishReason === "max-steps"),
      toolCalls: toolCalls.map(toStreamToolCallSummary),
      finishReason,
      ...(usage.totalTokens > 0 ? { usage: toStreamTokenUsage(usage) } : {}),
      durationMs: Date.now() - runStart
    };
  }
}