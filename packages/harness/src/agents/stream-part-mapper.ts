import type { TextStreamPart, ToolSet } from "ai";

import type { AgentToolCallResult } from "./types.js";
import type { AgentStreamEvent } from "./types.js";
import { TOOL_ERROR_PREFIX } from "../tools/index.js";

/**
 * 工具调用的计时表:tool-call 时打点,tool-result 时取差。
 * run() 局部持有,跨 step 共享(一个 toolCallId 的 call 与 result 可能跨 step)。
 */
export type ToolCallClock = Map<string, number>;

export interface MappedPart {
  /** 要转发给上层的事件;undefined 表示这个 part 不对外产出事件。 */
  readonly event?: AgentStreamEvent;
  /** 工具执行完成的记录(用于 finish 事件里的 toolCalls 汇总与观测)。 */
  readonly toolCall?: AgentToolCallResult;
  /** part 表示流被中断。 */
  readonly aborted?: boolean;
  /** part 表示流级错误,需要抛给外层处理 reactive compact。 */
  readonly error?: unknown;
}

/** 工具 execute 的返回值 → 纯文本。Eva 的工具都返回 string,非 string 是异常情况才 stringify。 */
export const toOutputText = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output);

const readToolStatus = (output: unknown): "success" | "error" =>
  toOutputText(output).startsWith(TOOL_ERROR_PREFIX) ? "error" : "success";

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

const takeDuration = (clock: ToolCallClock, toolCallId: string): number => {
  const startedAt = clock.get(toolCallId);
  clock.delete(toolCallId);
  return startedAt !== undefined ? Date.now() - startedAt : 0;
};

/**
 * SDK stream part → Eva 事件。
 *
 * 为什么单独成文件:这是纯翻译,没有任何控制逻辑。和循环放在一起时,
 * 15 个 case 会让人误以为循环很复杂,其实复杂的只有翻译表。
 */
export const mapStreamPart = <TOOLS extends ToolSet>(
  part: TextStreamPart<TOOLS>,
  clock: ToolCallClock
): MappedPart => {
  switch (part.type) {
    case "text-delta":
      return { event: { type: "text-delta", textDelta: part.text } };

    case "reasoning-delta":
      return { event: { type: "reasoning-delta", textDelta: part.text } };

    case "tool-input-start":
      return {
        event: { type: "tool-input-start", toolCallId: part.id, toolName: part.toolName }
      };

    case "tool-input-delta":
      return {
        event: { type: "tool-input-delta", toolCallId: part.id, delta: part.delta }
      };

    case "tool-call":
      clock.set(part.toolCallId, Date.now());

      return {
        event: {
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: (part.input as Record<string, unknown>) ?? {}
        }
      };

    case "tool-result": {
      const output = toOutputText(part.output);
      const status = readToolStatus(part.output);
      const durationMs = takeDuration(clock, part.toolCallId);

      return {
        event: {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output,
          status,
          ...(durationMs !== undefined ? { durationMs } : {})
        },
        toolCall: {
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          args: (part.input as Record<string, unknown>) ?? {},
          output,
          status,
          durationMs
        }
      };
    }

    case "tool-error": {
      // 工具执行抛出但未被 buildTool 包成异常的情况(ai 层错误)。
      const output = toErrorMessage(part.error);
      const durationMs = takeDuration(clock, part.toolCallId);

      return {
        event: {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output,
          status: "error",
          ...(durationMs !== undefined ? { durationMs } : {})
        },
        toolCall: {
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          args: (part.input as Record<string, unknown>) ?? {},
          output,
          status: "error",
          durationMs
        }
      };
    }

    case "abort":
      return { aborted: true };

    case "error":
      return { error: part.error };

    default:
      // start / start-step / finish-step / finish / raw / source / file /
      // text-start / text-end / reasoning-start / reasoning-end /
      // tool-input-end / tool-output-denied / tool-approval-* 都不对外产出事件。
      return {};
  }
};