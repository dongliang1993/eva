import type {
  AssistantModelMessage,
  ToolModelMessage,
} from "ai";
import type { TextStreamPart, ToolSet } from "ai";

import {
  assistantMessage,
  streamEventMessage,
  turnCompleteMessage,
  userMessage,
} from "./messages.js";
import type { HarnessMessage, TokenUsage, ToolResult } from "./types.js";

/**
 * 一次模型调用（一个 turn）：消费 AI SDK stream part,按契约顺序产出消息。
 *
 *   stream_event(step_start) 恒发,先于本次调用的任何其他消息
 *   → (stream_event)* (text/reasoning/tool_input;includePartialMessages 开关)
 *   → (assistant)+     每个内容块完成时一条:text-end / reasoning-end / tool-call
 *   → system/turn_complete(usage/duration 在调用结束时才有,由 finishTurn 补)
 *   → (user)?          本次调用全部工具的结果,一条消息装全部(finishTurn 补)
 *
 * 顺序是硬约束:tool-call 块一到就发 assistant —— AI SDK 随即开始执行这个工具
 * (canUseTool 会发审批帧),所以 tool-call 的 assistant 必须先于审批发生。
 * text 的窗口合并(STREAM_COALESCE_WINDOW_MS)在 query 层做,这里逐 delta 原样发。
 */

export interface TurnInput {
  readonly turn: number;
  readonly parentToolUseID: string | null;
  /** false 时 text/reasoning 的 stream_event 不发(assistant 是唯一文本来源)。 */
  readonly includePartialMessages: boolean;
  readonly stream: AsyncIterable<TextStreamPart<ToolSet>>;
  readonly turnStartedAt: number;
}

/** 流消费完的产出:消息序列 + 工具结果(id/名字/文本/成败) + ttft。 */
export interface TurnOutput {
  readonly messages: readonly HarnessMessage[];
  readonly toolResults: readonly ToolResultOnStream[];
  readonly ttftMs: number | null;
}

/** tool-result part 的收集形态:状态(isError)从输出文本判(单一通道,与投影一致)。 */
export interface ToolResultOnStream {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly outputText: string;
  readonly isError: boolean;
}

/**
 * part.output → (text, isError)。
 *
 * Eva 的工具(toAiTool)execute 返回 ToolResult:{ content: [{type:"text", text}], isError? }。
 * part.output 是这个对象原样(回灌给模型的 toModelOutput 是另一条路)。
 * Error: 前缀是 runToolCall 的 errorResult 拼的 —— isError 优先读对象字段,前缀是兜底
 * (历史消息 / abort 补发只有文本)。
 */
const toolResultFromOutput = (
  output: unknown,
): { outputText: string; isError: boolean } => {
  if (
    typeof output === "object" && output !== null &&
    "content" in output && Array.isArray((output as { content?: unknown }).content)
  ) {
    const evaResult = output as {
      content: readonly { readonly type: string; readonly text?: string }[];
      isError?: boolean;
    };
    const text = evaResult.content
      .map((part2) => (part2.type === "text" ? part2.text ?? "" : ""))
      .join("");
    return { outputText: text, isError: evaResult.isError === true || text.startsWith("Error:") };
  }
  if (
    typeof output === "object" && output !== null && "type" in output &&
    (output as { type?: unknown }).type === "text"
  ) {
    const value = (output as { value?: unknown }).value;
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    return { outputText: text, isError: text.startsWith("Error:") };
  }
  const text = JSON.stringify(output ?? null);
  return { outputText: text, isError: text.startsWith("Error:") };
};

/**
 * runTurn 的流式版:逐消息产出(生成器),终局(toolResults/ttft)由 final() 取。
 * run-loop 边消费边 yield —— abort 发生在流的中间时,消费者在任一 yield 点叫停。
 */
export const runTurnStream = (
  input: TurnInput,
): {
  [Symbol.asyncIterator](): AsyncGenerator<HarnessMessage>;
  final(): Promise<{ toolResults: readonly ToolResultOnStream[]; ttftMs: number | null }>;
} => {
  const collected: ToolResultOnStream[] = [];
  let ttftMs: number | null = null;

  const inner = (async function* (): AsyncGenerator<HarnessMessage> {
    // step_start 恒发:先于本次调用的任何其他消息。
    yield streamEventMessage(
      { type: "step_start", turn: input.turn },
      input.parentToolUseID,
    );

    const textBuffers = new Map<string, string>();
    const reasoningBuffers = new Map<string, string>();
    let sawFirstToken = false;

    const assistant = (content: AssistantModelMessage["content"]): HarnessMessage =>
      assistantMessage({
        message: { role: "assistant", content },
        turn: input.turn,
        parentToolUseID: input.parentToolUseID,
      });

    for await (const part of input.stream) {
      if (!sawFirstToken && isTokenPart(part)) {
        sawFirstToken = true;
        ttftMs = Date.now() - input.turnStartedAt;
      }

      switch (part.type) {
        case "text-delta": {
          textBuffers.set(part.id, (textBuffers.get(part.id) ?? "") + part.text);
          if (input.includePartialMessages) {
            yield streamEventMessage(
              { type: "text_delta", text: part.text },
              input.parentToolUseID,
            );
          }
          break;
        }
        case "reasoning-delta": {
          reasoningBuffers.set(part.id, (reasoningBuffers.get(part.id) ?? "") + part.text);
          if (input.includePartialMessages) {
            yield streamEventMessage(
              { type: "reasoning_delta", text: part.text },
              input.parentToolUseID,
            );
          }
          break;
        }
        case "text-start":
          textBuffers.set(part.id, "");
          break;
        case "reasoning-start":
          reasoningBuffers.set(part.id, "");
          break;
        case "text-end":
          yield assistant([{ type: "text", text: textBuffers.get(part.id) ?? "" }]);
          textBuffers.delete(part.id);
          break;
        case "reasoning-end": {
          const text = reasoningBuffers.get(part.id) ?? "";
          if (text.length > 0) {
            yield assistant([{ type: "reasoning", text, providerOptions: {} }]);
          }
          reasoningBuffers.delete(part.id);
          break;
        }
        case "tool-input-start":
          yield streamEventMessage(
            {
              type: "tool_input_start",
              tool_use_id: part.id,
              tool_name: part.toolName,
            },
            input.parentToolUseID,
          );
          break;
        case "tool-input-delta":
          yield streamEventMessage(
            {
              type: "tool_input_delta",
              tool_use_id: part.id,
              delta: part.delta,
            },
            input.parentToolUseID,
          );
          break;
        case "tool-input-end":
          break;
        case "tool-call":
          // 到达即发:工具执行(AI SDK 内部)与审批紧随其后。
          yield assistant([{
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: (part.input as Record<string, unknown>) ?? {},
          }]);
          break;
        case "tool-result": {
          const collectedResult = toolResultFromOutput(part.output);
          collected.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            outputText: collectedResult.outputText,
            isError: collectedResult.isError,
          });
          break;
        }
        case "error":
          // 流级错误:往上抛,run-loop 的 catch 接住走 reactive compact / 终态。
          throw part.error;
        case "tool-error": {
          // ai 层错误(execute 之外):折叠成已收口的结果,状态 error。
          const collectedResult = toolResultFromOutput({ type: "text", value: `Error: ${part.error instanceof Error ? part.error.message : String(part.error)}` });
          collected.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            outputText: collectedResult.outputText,
            isError: true,
          });
          break;
        }
        default:
          // start/start-step/finish-step/finish/raw/source/file:
          // 控制流与终态由调用方(run-loop)处理。
          break;
      }
    }

    // 流中途断在文本块里(abort/异常):缓冲里剩下的文本不丢,补一条 assistant。
    for (const text of textBuffers.values()) {
      if (text.length > 0) yield assistant([{ type: "text", text }]);
    }
  })();

  return {
    [Symbol.asyncIterator]: () => inner,
    final: async () => {
      // 驱动到底(调用方可能中途 break);生成器幂等,重复驱动只是快速走完。
      for await (const _ of inner) {
        void _;
      }
      return { toolResults: collected, ttftMs };
    },
  };
};

/** 消费一次模型调用的 stream part。纯翻译:控制流(maxSteps/abort)在调用方。 */
export const runTurn = async (input: TurnInput): Promise<TurnOutput> => {
  const messages: HarnessMessage[] = [
    // step_start 恒发:先于本次调用的任何其他消息(前端靠它分段,轨迹页靠它记 step)。
    streamEventMessage(
      { type: "step_start", turn: input.turn },
      input.parentToolUseID,
    ),
  ];
  const toolResults: TurnOutput["toolResults"][number][] = [];

  // 文本/推理块按 id 累积:delta 进 buffer,end 时发一条 assistant。
  // tool-call 块到达即发 assistant(不等 finish)——审批帧依赖这条先到。
  const textBuffers = new Map<string, string>();
  const reasoningBuffers = new Map<string, string>();
  let ttftMs: number | null = null;
  let sawFirstToken = false;

  const assistant = (content: AssistantModelMessage["content"]): void => {
    messages.push(assistantMessage({
      message: { role: "assistant", content },
      turn: input.turn,
      parentToolUseID: input.parentToolUseID,
    }));
  };

  for await (const part of input.stream) {
    if (!sawFirstToken && isTokenPart(part)) {
      sawFirstToken = true;
      ttftMs = Date.now() - input.turnStartedAt;
    }

    switch (part.type) {
      case "text-delta": {
        textBuffers.set(part.id, (textBuffers.get(part.id) ?? "") + part.text);
        if (input.includePartialMessages) {
          messages.push(streamEventMessage(
            { type: "text_delta", text: part.text },
            input.parentToolUseID,
          ));
        }
        break;
      }

      case "reasoning-delta": {
        reasoningBuffers.set(part.id, (reasoningBuffers.get(part.id) ?? "") + part.text);
        if (input.includePartialMessages) {
          messages.push(streamEventMessage(
            { type: "reasoning_delta", text: part.text },
            input.parentToolUseID,
          ));
        }
        break;
      }

      case "text-start": {
        textBuffers.set(part.id, "");
        break;
      }

      case "reasoning-start": {
        reasoningBuffers.set(part.id, "");
        break;
      }

      case "text-end": {
        // includePartialMessages=false 时这条 assistant 是唯一的文本来源。
        assistant([{ type: "text", text: textBuffers.get(part.id) ?? "" }]);
        textBuffers.delete(part.id);
        break;
      }

      case "reasoning-end": {
        const text = reasoningBuffers.get(part.id) ?? "";
        if (text.length > 0) {
          assistant([{ type: "reasoning", text, providerOptions: {} }]);
        }
        reasoningBuffers.delete(part.id);
        break;
      }

      case "tool-input-start": {
        messages.push(streamEventMessage(
          {
            type: "tool_input_start",
            tool_use_id: part.id,
            tool_name: part.toolName,
          },
          input.parentToolUseID,
        ));
        break;
      }

      case "tool-input-delta": {
        messages.push(streamEventMessage(
          {
            type: "tool_input_delta",
            tool_use_id: part.id,
            delta: part.delta,
          },
          input.parentToolUseID,
        ));
        break;
      }

      case "tool-input-end":
        break;

      case "tool-call": {
        // 到达即发:工具执行(AI SDK 内部)与审批紧随其后。
        assistant([{
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: (part.input as Record<string, unknown>) ?? {},
        }]);
        break;
      }

      case "tool-result": {
        // output 是 ToolResultOutput(text 是 toModelOutput(textOf) 的产物);
        // isError 经 output 里的 Error: 判不可靠 —— 状态由 timings/output 双源:
        // runToolCall 的结果对象不进 part,这里只收 id/name,input 从 tool-call part
        // 拿不到(它已发过 assistant),由 runToolCall 侧通过 timings 附带 —— 不行。
        // 真正的单一事实源:run-loop 在派发后持有结果对象,turn 只按 id 收集。
        const collected = toolResultFromOutput(part.output);
        toolResults.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          outputText: collected.outputText,
          isError: collected.isError,
        });
        break;
      }

      case "error":
        // 流级错误:往上抛,调用方的 catch 接住。
        throw part.error;
      case "tool-error": {
        const collectedResult = toolResultFromOutput({ type: "text", value: `Error: ${part.error instanceof Error ? part.error.message : String(part.error)}` });
        toolResults.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          outputText: collectedResult.outputText,
          isError: true,
        });
        break;
      }
      default:
        // start / start-step / finish-step / finish / raw / source / file:
        // 控制流与终态由调用方(run-loop)处理。
        break;
    }
  }

  // 流中途断在文本块里(abort/异常):缓冲里剩下的文本不丢,补一条 assistant。
  // 真实 provider 下 text-end 总会先到;这是防御,不进契约顺序。
  for (const text of textBuffers.values()) {
    if (text.length > 0) assistant([{ type: "text", text }]);
  }

  return { messages, toolResults, ttftMs };
};

const isTokenPart = (part: TextStreamPart<ToolSet>): boolean =>
  part.type === "text-delta" ||
  part.type === "reasoning-delta" ||
  part.type === "tool-input-start" ||
  part.type === "tool-call";

/** 流消费完后补终局两条:system/turn_complete + (user)?。 */
export const finishTurn = (input: {
  readonly turn: number;
  readonly parentToolUseID: string | null;
  readonly ttftMs: number | null;
  readonly durationMs: number;
  readonly stopReason: string;
  readonly usage: TokenUsage;
  readonly toolResults: readonly ToolResultOnStream[];
  readonly toolTiming: Readonly<Record<string, import("./types.js").ToolTiming>>;
}): readonly HarnessMessage[] => {
  const messages: HarnessMessage[] = [
    turnCompleteMessage({
      turn: input.turn,
      usage: input.usage,
      ttftMs: input.ttftMs,
      durationMs: input.durationMs,
      stopReason: input.stopReason,
      parentToolUseID: input.parentToolUseID,
    }),
  ];

  if (input.toolResults.length > 0) {
    messages.push(userMessage({
      message: {
        role: "tool",
        content: input.toolResults.map((result) => ({
          type: "tool-result" as const,
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          input: {},
          output: {
            type: "text" as const,
            value: result.outputText,
          },
        })) as ToolModelMessage["content"],
      },
      turn: input.turn,
      toolTiming: input.toolTiming,
      parentToolUseID: input.parentToolUseID,
    }));
  }

  return messages;
};
