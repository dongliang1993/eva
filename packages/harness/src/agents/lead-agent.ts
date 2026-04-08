import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  coerceMessageLikeToMessage,
  type BaseMessage
} from "@langchain/core/messages";
import { concat } from "@langchain/core/utils/stream";

import type { AgentModel } from "../models/agent-model.js";
import type { AgentTool } from "../tools.js";
import { buildAgentSystemPrompt } from "../prompts/prompt-builder.js";
import {
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  extractTokenUsage,
  isMaxOutputContinuationCandidate,
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
import type {
  AgentRunInput,
  AgentRunResult,
  AgentStreamEvent,
  AgentToolCallResult,
  Agent
} from "./types.js";

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

const stringifyContent = (content: unknown): string => {
  if (content === undefined || content === null) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (
          typeof item === "object" &&
          item !== null &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          return item.text;
        }

        return JSON.stringify(item);
      })
      .join("\n");
  }

  return JSON.stringify(content) ?? "";
};

const toToolMessage = (
  toolResult: unknown,
  toolCallId: string
): ToolMessage => {
  if (toolResult instanceof ToolMessage) {
    return toolResult;
  }

  return new ToolMessage({
    content: stringifyContent(toolResult),
    tool_call_id: toolCallId,
    status: "success"
  });
};

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

interface ToolCallMeta {
  name: string;
  id: string;
}

const reconstructToolCalls = (
  accumulated: AIMessageChunk,
  metaByIndex: Map<number, ToolCallMeta>
): NonNullable<AIMessage["tool_calls"]> => {
  if (accumulated.tool_calls && accumulated.tool_calls.length > 0) {
    return accumulated.tool_calls;
  }

  if (!accumulated.tool_call_chunks || accumulated.tool_call_chunks.length === 0) {
    return [];
  }

  return accumulated.tool_call_chunks
    .filter((chunk) => chunk.args)
    .map((chunk) => {
      const meta = metaByIndex.get(chunk.index ?? 0);
      const args =
        typeof chunk.args === "string" ? JSON.parse(chunk.args) : (chunk.args ?? {});
      const resolvedId = chunk.id ?? meta?.id;

      return {
        name: chunk.name || meta?.name || "",
        args,
        ...(resolvedId !== undefined ? { id: resolvedId } : {}),
        type: "tool_call" as const
      };
    });
};

const chunkToAIMessage = (
  accumulated: AIMessageChunk,
  metaByIndex: Map<number, ToolCallMeta>
): AIMessage =>
  new AIMessage({
    content: accumulated.content,
    tool_calls: reconstructToolCalls(accumulated, metaByIndex),
    response_metadata: accumulated.response_metadata,
      ...(accumulated.id !== undefined ? { id: accumulated.id } : {})
  });

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

type RunMode = "wait" | "stream";

type ModelReadEvent =
  | { type: "text_chunk"; content: string }
  | { type: "reply"; reply: AIMessage };

interface RunLoopState {
  runStart: number;
  totalTokens: TokenUsage;
  messages: BaseMessage[];
  runtimePrefixMessageCount: number;
  toolCalls: AgentToolCallResult[];
  maxSteps: number;
  tools: Map<string, AgentTool>;
  maxOutputRecoveryCount: number;
  continuedAssistantText: string;
  completedSteps: number;
}

export interface LeadAgentOptions {
  model: AgentModel;
  tools?: AgentTool[];
  systemPrompt?: string | SystemMessage;
  maxSteps?: number;
  observer?: AgentObserver;
  contextPolicy?: ContextWindowPolicyOptions;
}

const resolveSystemMessage = (prompt: string | SystemMessage | undefined): SystemMessage => {
  if (prompt instanceof SystemMessage) {
    return prompt;
  }

  return new SystemMessage(prompt?.trim() || buildAgentSystemPrompt());
};

export class LeadAgent implements Agent {
  private readonly toolsByName: Map<string, AgentTool>;
  private readonly systemMessage: SystemMessage;
  private readonly maxSteps: number;
  private readonly observer: AgentObserver | undefined;
  private readonly contextPolicy: ContextWindowPolicy;

  constructor(private readonly options: LeadAgentOptions) {
    this.toolsByName = new Map(
      (options.tools ?? []).map((tool) => [tool.name, tool])
    );
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

  private buildMessages(input: AgentRunInput): BaseMessage[] {
    const messages: BaseMessage[] = [this.systemMessage];
    const context = formatContext(input.context);

    if (context) {
      messages.push(new HumanMessage(context));
    }

    messages.push(...input.messages.map(coerceMessageLikeToMessage));

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
      state.tools,
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

  private async *readModelReply(
    mode: RunMode,
    messages: BaseMessage[],
    tools: readonly AgentTool[]
  ): AsyncGenerator<ModelReadEvent> {
    if (mode === "wait") {
      const reply = await this.options.model.invoke(messages, [...tools]);
      yield { type: "reply", reply };
      return;
    }

    let accumulated: AIMessageChunk | undefined;
    const toolCallMeta = new Map<number, ToolCallMeta>();

    for await (const chunk of this.options.model.stream(messages, [...tools])) {
      if (chunk.tool_call_chunks) {
        for (const tc of chunk.tool_call_chunks) {
          const index = tc.index ?? 0;
          const existing = toolCallMeta.get(index);

          if (tc.name || tc.id) {
            toolCallMeta.set(index, {
              name: tc.name || existing?.name || "",
              id: tc.id || existing?.id || ""
            });
          }
        }
      }

      accumulated = accumulated ? concat(accumulated, chunk) : chunk;

      const text = typeof chunk.content === "string" ? chunk.content : "";

      if (text) {
        yield { type: "text_chunk", content: text };
      }
    }

    if (accumulated) {
      yield {
        type: "reply",
        reply: chunkToAIMessage(accumulated, toolCallMeta)
      };
    }
  }

  private async *executeToolCalls(
    state: RunLoopState,
    step: number,
    reply: AIMessage
  ): AsyncGenerator<AgentStreamEvent, AgentRunResult | undefined> {
    for (const toolCall of reply.tool_calls ?? []) {
      const tool = state.tools.get(toolCall.name);
      const toolCallId = toolCall.id ?? `${toolCall.name}-${state.toolCalls.length + 1}`;

      if (!tool) {
        const output = `Tool "${toolCall.name}" is not registered on this agent.`;

        state.messages.push(
          new ToolMessage({
            content: output,
            tool_call_id: toolCallId,
            status: "error"
          })
        );
        state.toolCalls.push({
          toolName: toolCall.name,
          toolCallId,
          args: toolCall.args,
          output,
          status: "error"
        });

        yield {
          type: "tool_call_end",
          toolName: toolCall.name,
          toolCallId,
          output,
          status: "error"
        };
        continue;
      }

      yield {
        type: "tool_call_start",
        toolName: toolCall.name,
        toolCallId,
        args: toolCall.args
      };

      this.emit({ type: "tool_call_start", step, toolName: toolCall.name, toolCallId });
      const toolStart = Date.now();

      try {
        const result = await tool.invoke(toolCall.args);
        const toolMessage = toToolMessage(result, toolCallId);
        const output = stringifyContent(toolMessage.content);
        const toolDurationMs = Date.now() - toolStart;
        const status = toolMessage.status ?? "success";

        state.messages.push(toolMessage);
        state.toolCalls.push({
          toolName: toolCall.name,
          toolCallId,
          args: toolCall.args,
          output,
          status,
          durationMs: toolDurationMs
        });

        yield {
          type: "tool_call_end",
          toolName: toolCall.name,
          toolCallId,
          output,
          status
        };

        this.emit({
          type: "tool_call_end",
          step,
          toolName: toolCall.name,
          toolCallId,
          status,
          durationMs: toolDurationMs
        });

        if ("returnDirect" in tool && tool.returnDirect === true) {
          return {
            text: output,
            toolCalls: state.toolCalls
          };
        }
      } catch (error) {
        const output = toErrorMessage(error);
        const toolDurationMs = Date.now() - toolStart;

        state.messages.push(
          new ToolMessage({
            content: output,
            tool_call_id: toolCallId,
            status: "error"
          })
        );
        state.toolCalls.push({
          toolName: toolCall.name,
          toolCallId,
          args: toolCall.args,
          output,
          status: "error",
          durationMs: toolDurationMs
        });

        yield {
          type: "tool_call_end",
          toolName: toolCall.name,
          toolCallId,
          output,
          status: "error"
        };

        this.emit({
          type: "tool_call_end",
          step,
          toolName: toolCall.name,
          toolCallId,
          status: "error",
          durationMs: toolDurationMs
        });
      }
    }

    return undefined;
  }

  private async *runLoop(
    state: RunLoopState,
    mode: RunMode
  ): AsyncGenerator<AgentStreamEvent> {
    this.emit({ type: "agent_run_start" });

    for (let step = 0; step < state.maxSteps; step += 1) {
      let hasAttemptedReactiveCompact = false;
      let continuedDueToMaxOutput = false;

      while (true) {
        this.prepareMessagesForModel(state, step);

        this.emit({ type: "llm_call_start", step });
        const llmStart = Date.now();
        let reply: AIMessage | undefined;
        let emittedTextChunk = false;

        try {
          for await (const event of this.readModelReply(
            mode,
            state.messages,
            [...state.tools.values()]
          )) {
            if (event.type === "text_chunk") {
              emittedTextChunk = true;
              yield event;
              continue;
            }

            reply = event.reply;
          }
        } catch (error) {
          if (
            !hasAttemptedReactiveCompact
            && (!emittedTextChunk || mode === "wait")
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

        if (!reply) {
          this.emit({
            type: "llm_call_end",
            step,
            durationMs: Date.now() - llmStart,
            hasToolCalls: false
          });
          state.completedSteps = step + 1;
          this.emitRunEnd(state, step + 1);

          yield {
            type: "result",
            text: "The model returned an empty response.",
            toolCalls: state.toolCalls
          };
          return;
        }

        const tokenUsage = extractTokenUsage(
          reply.response_metadata as Record<string, unknown> | undefined
        );
        this.emit({
          type: "llm_call_end",
          step,
          durationMs: Date.now() - llmStart,
          ...(tokenUsage !== undefined ? { tokenUsage } : {}),
          hasToolCalls: (reply.tool_calls?.length ?? 0) > 0
        });

        if (tokenUsage) {
          state.totalTokens = addTokenUsage(state.totalTokens, tokenUsage);
        }

        state.messages.push(reply);
        state.completedSteps = step + 1;

        if (!reply.tool_calls || reply.tool_calls.length === 0) {
          const replyText = stringifyContent(reply.content);
          const responseMetadata =
            reply.response_metadata as Record<string, unknown> | undefined;

          if (
            isMaxOutputContinuationCandidate(responseMetadata)
            && state.maxOutputRecoveryCount < this.contextPolicy.maxOutputRecoveryLimit
          ) {
            state.continuedAssistantText = appendContinuationText(
              state.continuedAssistantText,
              replyText
            );
            state.messages.push(new HumanMessage(MAX_OUTPUT_CONTINUATION_MESSAGE));
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
            type: "result",
            text: finalizeAssistantText(state.continuedAssistantText, replyText),
            toolCalls: state.toolCalls
          };
          return;
        }

        const directResult = yield* this.executeToolCalls(state, step, reply);

        if (directResult) {
          this.emitRunEnd(state, step + 1);
          yield { type: "result", ...directResult };
          return;
        }

        this.emitLoopTransition(step, "next_turn");
        break;
      }

      if (continuedDueToMaxOutput) {
        continue;
      }
    }

    this.emitRunEnd(state, state.maxSteps);
    yield {
      type: "result",
      text:
        "The agent reached the maximum tool-calling steps without producing a final answer.",
      toolCalls: state.toolCalls
    };
  }

  async invoke(input: AgentRunInput): Promise<AgentRunResult> {
    const state = this.createRunLoopState(input);
    let finalResult: AgentRunResult | undefined;

    for await (const event of this.runLoop(state, "wait")) {
      if (event.type === "result") {
        finalResult = {
          text: event.text,
          toolCalls: event.toolCalls
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
      yield* this.runLoop(state, "stream");
    } catch (error) {
      this.emitRunEnd(state, state.completedSteps);
      yield { type: "error", message: toErrorMessage(error) };
    }
  }
}
