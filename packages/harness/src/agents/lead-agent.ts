import {
  isStepCount as stepCountIs,
  streamText,
  type AssistantModelMessage,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolModelMessage,
  type ToolResultPart,
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
import { applyToolResultBudget } from "../context/tool-result-budget.js";
import {
  applyProactiveLoopCompactWithStats,
  applyReactiveLoopCompactWithStats,
  type RuntimeCompactResult
} from "../context/runtime-compact.js";
import { isReactiveCompactCandidateError } from "../models/errors.js";
import { coalesceTextDeltas } from "./coalesce-stream.js";
import type {
  AgentCallSettings,
  AgentRunInput,
  AgentRunResult,
  AgentStreamEvent,
  AgentToolCallResult,
  RequestApproval,
  Agent
} from "./types.js";

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const toStreamTokenUsage = (usage: TokenUsage): StreamTokenUsage => ({
  inputTokens: usage.promptTokens,
  outputTokens: usage.completionTokens,
  totalTokens: usage.totalTokens
});

const toStreamToolCallSummary = (
  toolCall: AgentToolCallResult
): StreamToolCallSummary => ({
  toolName: toolCall.toolName,
  toolCallId: toolCall.toolCallId ?? "",
  args: toolCall.args,
  output: toolCall.output,
  status: toolCall.status,
  ...(toolCall.durationMs !== undefined ? { durationMs: toolCall.durationMs } : {})
});

const formatContext = (context: Record<string, unknown> | undefined): string | undefined => {
  if (!context || Object.keys(context).length === 0) {
    return undefined;
  }

  return [
    "Additional context:",
    "```json",
    JSON.stringify(context, null, 2),
    "```"
  ].join("\n");
};

const MAX_OUTPUT_CONTINUATION_MESSAGE =
  "Continue directly. Do not apologize. Do not repeat previous content.";

const appendContinuationText = (
  accumulated: string,
  fragment: string
): string => `${accumulated}${fragment}`;

const finalizeAssistantText = (
  accumulated: string,
  finalFragment: string
): string => {
  const combined = appendContinuationText(accumulated, finalFragment).trim();

  return combined.length > 0
    ? combined
    : "The agent returned an empty response.";
};

// 把 ToolResultPart.output 拍平成纯文本,用于事件产出和统计。
const stringifyToolOutput = (output: ToolResultPart["output"]): string => {
  switch (output.type) {
    case "text":
      return output.value;
    case "json":
      return typeof output.value === "string" ? output.value : JSON.stringify(output.value);
    case "execution-denied":
      return `Execution denied${output.reason ? `: ${output.reason}` : ""}`;
    case "error-text":
      return output.value;
    case "error-json":
      return typeof output.value === "string" ? output.value : JSON.stringify(output.value);
    default:
      return JSON.stringify(output);
  }
};

// eva 的 buildTool 把执行错误包成 "[Tool Error] ..." 文本返回,没有 isError 标记。
const readToolStatus = (output: ToolResultPart["output"]): "success" | "error" => {
  const text = stringifyToolOutput(output);
  return text.startsWith("[Tool Error]") ? "error" : "success";
};

// LanguageModelUsage(inputTokens/outputTokens/totalTokens) → eva 的 TokenUsage。
const readTokenUsage = (usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
} | undefined): TokenUsage | undefined => {
  if (!usage) {
    return undefined;
  }

  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return undefined;
  }

  return { promptTokens, completionTokens, totalTokens };
};

type RunMode = "wait" | "stream";

// streamText 单步执行时收集的产物:文本片段、tool-call part、tool-result part、
// finishReason 与 token usage。从 result.stream 的 stream part 里抽出来。
interface StepCollect {
  readonly text: string;
  readonly toolCalls: ToolCallPart[];
  readonly toolResults: ToolResultPart[];
  readonly finishReason: string | undefined;
  readonly usage: TokenUsage | undefined;
}

interface RunLoopState {
  runStart: number;
  totalTokens: TokenUsage;
  messages: ModelMessage[];
  runtimePrefixMessageCount: number;
  toolCalls: AgentToolCallResult[];
  maxSteps: number;
  tools: Map<string, AgentTool>;
  maxOutputRecoveryCount: number;
  continuedAssistantText: string;
  completedSteps: number;
}

export interface LeadAgentOptions {
  model: LanguageModel;
  tools?: AgentTool[];
  systemPrompt?: string | SystemModelMessage;
  maxSteps?: number;
  observer?: AgentObserver;
  contextPolicy?: ContextWindowPolicyOptions;
  /** 危险工具执行前的用户审批入口(由宿主注入)。缺省时危险工具直接执行。 */
  requestApproval?: RequestApproval;
  callSettings?: AgentCallSettings;
}

const resolveSystemMessage = (
  prompt: string | SystemModelMessage | undefined
): SystemModelMessage => {
  if (typeof prompt === "object" && prompt !== null && prompt.role === "system") {
    return prompt;
  }

  return {
    role: "system",
    content: (typeof prompt === "string" ? prompt : undefined)?.trim() || buildAgentSystemPrompt()
  };
};

export class LeadAgent implements Agent {
  private readonly toolsByName: Map<string, AgentTool>;
  private readonly systemMessage: SystemModelMessage;
  private readonly maxSteps: number;
  private readonly observer: AgentObserver | undefined;
  private readonly contextPolicy: ContextWindowPolicy;
  private readonly requestApproval: RequestApproval | undefined;

  constructor(private readonly options: LeadAgentOptions) {
    this.toolsByName = new Map(
      (options.tools ?? []).map((tool) => [tool.name, tool])
    );
    this.systemMessage = resolveSystemMessage(options.systemPrompt);
    this.maxSteps = options.maxSteps ?? 5;
    this.observer = options.observer;
    this.requestApproval = options.requestApproval;
    this.contextPolicy = resolveContextWindowPolicy(options.contextPolicy);
  }

  private emit(event: AgentTelemetryEvent): void {
    try {
      this.observer?.(event);
    } catch {
      // Observer errors must never break the agent loop
    }
  }

  // state.messages 内部仍以 system prompt 开头(保持 runtime-compact 的 prefix
  // 计算与消息回灌逻辑不变)。在 runSingleStep 调 streamText 前,system 消息
  // (system prompt + Runtime summary)会被 splitInstructionsAndMessages 拆出来走
  // instructions —— Vercel v5 禁止 messages 字段里出现 system 消息。
  private buildMessages(input: AgentRunInput): ModelMessage[] {
    const messages: ModelMessage[] = [this.systemMessage];
    const context = formatContext(input.context);

    if (context) {
      messages.push({ role: "user", content: context });
    }

    messages.push(...input.messages);

    return messages;
  }

  private resolveTools(input: AgentRunInput): Map<string, AgentTool> {
    if (!input.additionalTools || input.additionalTools.length === 0) {
      return this.toolsByName;
    }

    const merged = new Map(this.toolsByName);

    for (const tool of input.additionalTools) {
      merged.set(tool.name, tool);
    }

    return merged;
  }

  private createRunLoopState(input: AgentRunInput): RunLoopState {
    const messages = this.buildMessages(input);

    return {
      runStart: Date.now(),
      totalTokens: ZERO_TOKEN_USAGE,
      messages,
      runtimePrefixMessageCount: messages.length,
      toolCalls: [],
      maxSteps: input.maxSteps ?? this.maxSteps,
      tools: this.resolveTools(input),
      maxOutputRecoveryCount: 0,
      continuedAssistantText: "",
      completedSteps: 0
    };
  }

  private emitRunEnd(state: RunLoopState, stepCount: number): void {
    this.emit({
      type: "agent_run_end",
      totalDurationMs: Date.now() - state.runStart,
      stepCount,
      totalTokenUsage: state.totalTokens,
      toolCallCount: state.toolCalls.length
    });
  }

  private emitLoopTransition(
    step: number,
    reason: LoopTransitionReason,
    attempt?: number
  ): void {
    this.emit({
      type: "loop_transition",
      step,
      reason,
      ...(attempt !== undefined ? { attempt } : {})
    });
  }

  private emitContextCompaction(
    step: number,
    reason: ContextCompactionReason,
    result: RuntimeCompactResult
  ): void {
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

  private prepareMessagesForModel(state: RunLoopState, step: number): void {
    state.messages = applyToolResultBudget(
      state.messages,
      this.contextPolicy
    );

    const proactiveCompaction = applyProactiveLoopCompactWithStats(
      state.messages,
      state.runtimePrefixMessageCount,
      this.contextPolicy
    );

    state.messages = proactiveCompaction.messages;

    if (proactiveCompaction.changed) {
      this.emitContextCompaction(
        step,
        "proactive_loop_compact",
        proactiveCompaction
      );
      this.emitLoopTransition(step, "proactive_loop_compact");
    }
  }

  // Vercel v5 禁止 messages 里出现 system 消息:system prompt 和 Runtime summary
  // (compact 产生的)都是 system 角色。这里把 system 消息拆出来拼成 instructions,
  // 非 system 消息(user/assistant/tool)留在 messages 传给模型。
  // 顺序:system prompt 在前,Runtime summary(compact 产物)在后。
  private splitInstructionsAndMessages(
    messages: readonly ModelMessage[]
  ): { instructions: SystemModelMessage[]; messages: ModelMessage[] } {
    const instructions: SystemModelMessage[] = [];
    const nonSystem: ModelMessage[] = [];

    for (const message of messages) {
      if (message.role === "system") {
        instructions.push(message);
      } else {
        nonSystem.push(message);
      }
    }

    // system prompt 始终在最前(它是固定的 agent 指令),Runtime summary 在其后。
    // system prompt 通常是 instructions[0],但若 Runtime summary 已含 previous summary
    // 也无妨——它本身就是上下文回顾,作为 system 指令的一部分合理。
    return { instructions, messages: nonSystem };
  }

  private async *runSingleStep(
    mode: RunMode,
    state: RunLoopState,
    step: number,
    abortSignal: AbortSignal | undefined,
    out: { collect: StepCollect | undefined; aborted?: boolean }
  ): AsyncGenerator<AgentStreamEvent> {
    const toolSet: ToolSet = toToolSet([...state.tools.values()]);
    const emit = this.emit.bind(this);

    let text = "";
    const toolCalls: ToolCallPart[] = [];
    const toolResults: ToolResultPart[] = [];
    let finishReason: string | undefined;
    let usage: TokenUsage | undefined;
    const toolCallStartTimes = new Map<string, number>();

    // 审批: 官方「两轮模型调用」。streamText 用 toolApproval(返回 user-approval)对
    // needsApproval 工具产 tool-approval-request part; 收集审批, 把 tool-approval-response
    // push 到 messages, 再重新 streamText —— 直到本步无待审批工具。
    let rerun = true;
    try {
      while (rerun) {
        rerun = false;
        const { instructions, messages: promptMessages } = this.splitInstructionsAndMessages(
          state.messages
        );
        const approvalRequests: Array<{
          approvalId: string;
          toolCallId: string;
          toolName: string;
          input: unknown;
        }> = [];

        const result = streamText({
          model: this.options.model,
          instructions,
          messages: promptMessages,
          tools: toolSet,
          toolApproval: () => ({ type: "user-approval" }),
          stopWhen: stepCountIs(1),
          ...(abortSignal !== undefined ? { abortSignal } : {}),
          ...(this.options.callSettings?.temperature !== undefined
            ? { temperature: this.options.callSettings.temperature }
            : {}),
          ...(this.options.callSettings?.maxOutputTokens !== undefined
            ? { maxOutputTokens: this.options.callSettings.maxOutputTokens }
            : {}),
          onError: (event) => {
            // 错误会在 stream 里以 'error' part 出现;这里只记,不因拒而抛。
            void event;
          }
        });

        for await (const part of result.stream) {
          // SDK 不保证对忽略信号的 provider 流强制中断(尤其本地/mock 流),
          // 每个 part 消费前显式检查一次,确保 abort 确定性生效。
          if (abortSignal?.aborted) {
            out.collect = { text, toolCalls, toolResults, finishReason, usage };
            out.aborted = true;
            return;
          }

          switch (part.type) {
            case "text-delta": {
              text += part.text;

              if (mode === "stream") {
                yield {
                  type: "text-delta",
                  textDelta: part.text
                };
              }
              break;
            }

            case "reasoning-delta": {
              if (mode === "stream") {
                yield {
                  type: "reasoning-delta",
                  textDelta: part.text
                };
              }
              break;
            }

            case "tool-input-start": {
              if (mode === "stream") {
                yield {
                  type: "tool-input-start",
                  toolCallId: part.id,
                  toolName: part.toolName
                };
              }
              break;
            }

            case "tool-input-delta": {
              if (mode === "stream") {
                yield {
                  type: "tool-input-delta",
                  toolCallId: part.id,
                  delta: part.delta
                };
              }
              break;
            }

            case "tool-call": {
              const toolCallPart: ToolCallPart = {
                type: "tool-call",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input
              };
              toolCalls.push(toolCallPart);
              toolCallStartTimes.set(part.toolCallId, Date.now());

              if (mode === "stream") {
                yield {
                  type: "tool-call",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: (part.input as Record<string, unknown>) ?? {}
                };
              }

              emit({
                type: "tool_call_initiated",
                step,
                toolName: part.toolName,
                toolCallId: part.toolCallId
              });
              break;
            }

            case "tool-result": {
              const output = part.output as ToolResultPart["output"];
              const toolResultPart: ToolResultPart = {
                type: "tool-result",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output
              };
              toolResults.push(toolResultPart);

              const outputText = stringifyToolOutput(output);
              const status = readToolStatus(output);
              const startedAt = toolCallStartTimes.get(part.toolCallId);
              const durationMs = startedAt !== undefined ? Date.now() - startedAt : 0;
              toolCallStartTimes.delete(part.toolCallId);

              state.toolCalls.push({
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                args: (part.input as Record<string, unknown>) ?? {},
                output: outputText,
                status,
                durationMs
              });

              if (mode === "stream") {
                yield {
                  type: "tool-result",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  output: outputText,
                  status,
                  durationMs
                };
              }

              emit({
                type: "tool_call_completed",
                step,
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                status,
                durationMs
              });
              break;
            }

            case "tool-error": {
              // 工具执行抛出但未被 buildTool 包成文本的情况(ai 层错误)。
              const errorOutput = toErrorMessage(part.error);
              const errorResultPart: ToolResultPart = {
                type: "tool-result",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: { type: "text", value: errorOutput }
              };
              toolResults.push(errorResultPart);

              const startedAt = toolCallStartTimes.get(part.toolCallId);
              const durationMs = startedAt !== undefined ? Date.now() - startedAt : 0;
              toolCallStartTimes.delete(part.toolCallId);

              state.toolCalls.push({
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                args: (part.input as Record<string, unknown>) ?? {},
                output: errorOutput,
                status: "error",
                durationMs
              });

              if (mode === "stream") {
                yield {
                  type: "tool-result",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  output: errorOutput,
                  status: "error",
                  durationMs
                };
              }

              emit({
                type: "tool_call_completed",
                step,
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                status: "error",
                durationMs
              });
              break;
            }

            case "finish-step": {
              finishReason = part.finishReason;
              usage = readTokenUsage(part.usage);
              break;
            }

            case "error": {
              // 真正的流级错误(网络/模型异常)。交给外层 try/catch 处理 reactive compact。
              throw part.error;
            }

            case "tool-approval-request": {
              // 危险工具等待审批 → 记录审批请求, 本轮结束后处理。
              approvalRequests.push({
                approvalId: part.approvalId,
                toolCallId: part.toolCall.toolCallId,
                toolName: part.toolCall.toolName,
                input: part.toolCall.input
              });
              break;
            }

            default: {
              break;
            }
          }
        }

        // 若本步有等待审批的工具: 调 requestApproval 收决策 → push tool-approval-response
        // 到 messages → 重跑 streamText(官方"两轮模型调用")。
        if (approvalRequests.length > 0 && this.requestApproval) {
          const responses: Array<{ type: "tool-approval-response"; approvalId: string; approved: boolean }> = [];

          for (const req of approvalRequests) {
            const approved = await this.requestApproval({
              toolName: req.toolName,
              toolCallId: req.toolCallId,
              args: (req.input as Record<string, unknown>) ?? {}
            });

            if (abortSignal?.aborted) {
              out.collect = { text, toolCalls, toolResults, finishReason, usage };
              out.aborted = true;
              return;
            }

            responses.push({ type: "tool-approval-response", approvalId: req.approvalId, approved });
          }

          // 官方: 审批响应作为 tool-role 消息 push 回 messages, 重跑 streamText,
          // SDK 据此执行/拒绝危险工具。
          state.messages.push({
            role: "tool",
            content: responses
          } as ToolModelMessage);

          rerun = true;
          continue;
        }

        out.collect = { text, toolCalls, toolResults, finishReason, usage };
      }
    } catch (error) {
      if (isAbortError(error)) {
        out.collect = { text, toolCalls, toolResults, finishReason, usage };
        out.aborted = true;
        return;
      }
      throw error;
    }
  }

  // 把单步收集到的 assistant + tool messages 回灌到 state.messages,供下一轮 streamText 使用。
  private appendStepMessages(
    state: RunLoopState,
    collect: StepCollect
  ): void {
    const assistantContent: Array<TextPart | ToolCallPart> = [];

    if (collect.text.length > 0) {
      assistantContent.push({ type: "text", text: collect.text });
    }

    for (const toolCall of collect.toolCalls) {
      assistantContent.push(toolCall);
    }

    if (assistantContent.length > 0) {
      const assistantMessage: AssistantModelMessage = {
        role: "assistant",
        content: assistantContent
      };
      state.messages.push(assistantMessage);
    }

    if (collect.toolResults.length > 0) {
      const toolMessage: ToolModelMessage = {
        role: "tool",
        content: collect.toolResults
      };
      state.messages.push(toolMessage);
    }
  }

  private async *runLoop(
    state: RunLoopState,
    mode: RunMode,
    abortSignal: AbortSignal | undefined
  ): AsyncGenerator<AgentStreamEvent> {
    this.emit({ type: "agent_run_start" });

    for (let step = 0; step < state.maxSteps; step += 1) {
      let hasAttemptedReactiveCompact = false;
      let continuedDueToMaxOutput = false;

      while (true) {
        this.prepareMessagesForModel(state, step);

        this.emit({ type: "llm_call_start", step });
        yield { type: "step-start", step };
        const llmStart = Date.now();

        const collectHolder: { collect: StepCollect | undefined; aborted?: boolean } =
          { collect: undefined };

        let collect: StepCollect;
        try {
          for await (const event of this.runSingleStep(
            mode,
            state,
            step,
            abortSignal,
            collectHolder
          )) {
            yield event;
          }
          collect = collectHolder.collect!;
        } catch (error) {
          if (
            !hasAttemptedReactiveCompact
            && isReactiveCompactCandidateError(error)
          ) {
            const reactiveCompaction = applyReactiveLoopCompactWithStats(
              state.messages,
              state.runtimePrefixMessageCount
            );

            if (reactiveCompaction.changed) {
              state.messages = reactiveCompaction.messages;
              hasAttemptedReactiveCompact = true;
              this.emitContextCompaction(
                step,
                "reactive_compact_retry",
                reactiveCompaction
              );
              this.emitLoopTransition(step, "reactive_compact_retry");
              continue;
            }
          }

          throw error;
        }

        this.emit({
          type: "llm_call_end",
          step,
          durationMs: Date.now() - llmStart,
          ...(collect.usage !== undefined ? { tokenUsage: collect.usage } : {}),
          hasToolCalls: collect.toolCalls.length > 0
        });

        if (collect.usage) {
          state.totalTokens = addTokenUsage(state.totalTokens, collect.usage);
        }

        state.completedSteps = step + 1;

        if (collectHolder.aborted) {
          this.appendStepMessages(state, collect);
          this.emitRunEnd(state, step + 1);
          yield {
            type: "finish",
            text: finalizeAssistantText(state.continuedAssistantText, collect.text),
            toolCalls: state.toolCalls.map(toStreamToolCallSummary),
            finishReason: "aborted",
            ...(state.totalTokens.totalTokens > 0
              ? { usage: toStreamTokenUsage(state.totalTokens) }
              : {}),
            durationMs: Date.now() - state.runStart
          };
          return;
        }

        // 没有 assistant 文本也没有 tool call:模型返回空响应。
        if (collect.text.length === 0 && collect.toolCalls.length === 0) {
          this.emitRunEnd(state, step + 1);
          yield {
            type: "finish",
            text: "The model returned an empty response.",
            toolCalls: state.toolCalls.map(toStreamToolCallSummary),
            finishReason: "stop",
            ...(state.totalTokens.totalTokens > 0
              ? { usage: toStreamTokenUsage(state.totalTokens) }
              : {}),
            durationMs: Date.now() - state.runStart
          };
          return;
        }

        // 把这一步的 assistant + tool 消息回灌到 messages。
        this.appendStepMessages(state, collect);

        if (collect.toolCalls.length === 0) {
          // 无 tool call:本轮是最终文本回复。检查是否需要 max-output 续写。
          if (
            collect.finishReason === "length"
            && state.maxOutputRecoveryCount < this.contextPolicy.maxOutputRecoveryLimit
          ) {
            state.continuedAssistantText = appendContinuationText(
              state.continuedAssistantText,
              collect.text
            );
            state.messages.push({
              role: "user",
              content: MAX_OUTPUT_CONTINUATION_MESSAGE
            });
            state.maxOutputRecoveryCount += 1;
            this.emitLoopTransition(
              step,
              "max_output_tokens_recovery",
              state.maxOutputRecoveryCount
            );
            continuedDueToMaxOutput = true;
            break;
          }

          this.emitRunEnd(state, step + 1);
          yield {
            type: "finish",
            text: finalizeAssistantText(state.continuedAssistantText, collect.text),
            toolCalls: state.toolCalls.map(toStreamToolCallSummary),
            finishReason: "stop",
            ...(state.totalTokens.totalTokens > 0
              ? { usage: toStreamTokenUsage(state.totalTokens) }
              : {}),
            durationMs: Date.now() - state.runStart
          };
          return;
        }

        // 有 tool call:进入下一轮(下一个 step)继续。
        this.emitLoopTransition(step, "next_turn");
        break;
      }

      if (continuedDueToMaxOutput) {
        continue;
      }
    }

    this.emitRunEnd(state, state.maxSteps);
    yield {
      type: "finish",
      text:
        "The agent reached the maximum tool-calling steps without producing a final answer.",
      toolCalls: state.toolCalls.map(toStreamToolCallSummary),
      finishReason: "max-steps",
      ...(state.totalTokens.totalTokens > 0
        ? { usage: toStreamTokenUsage(state.totalTokens) }
        : {}),
      durationMs: Date.now() - state.runStart
    };
  }

  async invoke(input: AgentRunInput): Promise<AgentRunResult> {
    const state = this.createRunLoopState(input);
    let finalResult: AgentRunResult | undefined;

    for await (const event of this.runLoop(state, "wait", input.abortSignal)) {
      if (event.type === "finish") {
        finalResult = {
          text: event.text,
          toolCalls: event.toolCalls as AgentToolCallResult[]
        };
      }
    }

    if (!finalResult) {
      throw new Error("Agent finished without a result.");
    }

    return finalResult;
  }

  async *stream(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
    const state = this.createRunLoopState(input);

    try {
      yield* coalesceTextDeltas(
        this.runLoop(state, "stream", input.abortSignal)
      );
    } catch (error) {
      this.emitRunEnd(state, state.completedSteps);
      if (isAbortError(error)) {
        return;
      }
      yield { type: "error", message: toErrorMessage(error) };
    }
  }
}
