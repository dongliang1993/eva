import type { TextStreamPart, ToolSet } from "ai";

import type { ToolResult } from "../query/types.js";
import { textOf } from "../tools/tool.js";
import type { AgentToolCallResult } from "./types.js";
import type { AgentStreamEvent } from "./types.js";
/**
 * 三段计时的消费面(take 一次性取走快照)。
 * runToolCall 侧的 Map 经 run-loop 的 timingAdapter 适配到这里。
 */
export interface ToolTimingState {
  record(toolCallId: string, phase: "approval" | "queue" | "exec", ms: number, meta?: { aborted?: boolean }): void;
  take(toolCallId: string): { approvalWaitMs: number; queueWaitMs: number; execMs: number; execAborted: boolean };
}

/**
 * 工具调用的在飞台账:tool-call 时登记(toolName + 打点),tool-result 时取差并销账。
 * run() 局部持有,跨 step 共享(一个 toolCallId 的 call 与 result 可能跨 step)。
 * abort 收口时,台账里剩下的 entry 就是"已发起、未收口"的在飞调用 —— 据此补发取消结果。
 */
export interface InFlightToolCall {
  readonly toolName: string;
  readonly startedAt: number;
}

export type ToolCallClock = Map<string, InFlightToolCall>;

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

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

/** 工具执行结果 → SSE 的 output 文本。 */
const toResultOutput = (output: ToolResult | undefined): string =>
  output === undefined ? "" : textOf(output);

const toResultStatus = (output: ToolResult | undefined): "success" | "error" =>
  output?.isError === true ? "error" : "success";

/** take 一次,快照同时供 event 与 toolCall 汇总共用(第二次 take 会拿到全 0)。 */
const takeTiming = (timing: ToolTimingState | undefined, toolCallId: string) =>
  timing?.take(toolCallId);

const timingFields = (
  snapshot: ReturnType<typeof takeTiming>,
) =>
  snapshot === undefined
    ? {}
    : {
      toolExecMs: snapshot.execMs,
      approvalWaitMs: snapshot.approvalWaitMs,
      queueWaitMs: snapshot.queueWaitMs,
    };

const timingFieldsForSummary = (
  snapshot: ReturnType<typeof takeTiming>,
) =>
  snapshot === undefined
    ? {}
    : {
      toolExecMs: snapshot.execMs,
      approvalWaitMs: snapshot.approvalWaitMs,
      queueWaitMs: snapshot.queueWaitMs,
      execAborted: snapshot.execAborted,
    };

/**
 * SDK stream part → Eva 事件。
 *
 * 为什么单独成文件:这是纯翻译,没有任何控制逻辑。和循环放在一起时,
 * 15 个 case 会让人误以为循环很复杂,其实复杂的只有翻译表。
 */
export const mapStreamPart = <TOOLS extends ToolSet>(
  part: TextStreamPart<TOOLS>,
  clock: ToolCallClock,
  /** 三段计时汇聚,tool-result 时 take 取走快照(一次性)。 */
  toolTiming?: ToolTimingState
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
      clock.set(part.toolCallId, {
        toolName: part.toolName,
        startedAt: Date.now(),
      });

      return {
        event: {
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: (part.input as Record<string, unknown>) ?? {}
        }
      };

    case "tool-result": {
      // AI SDK 的 tool-result part 拿到的是完整 ToolResult(含 isError)。
      const output = part.output as ToolResult;
      const outputText = toResultOutput(output);
      const status = toResultStatus(output);
      // clock 只在飞销账,不再产出 durationMs —— 对外时间是三段计时。
      clock.delete(part.toolCallId);
      // take 只调一次,event 与 toolCall 共享同一份快照。
      const snapshot = takeTiming(toolTiming, part.toolCallId);

      return {
        event: {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: outputText,
          status,
          ...timingFields(snapshot)
        },
        toolCall: {
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          args: (part.input as Record<string, unknown>) ?? {},
          output: outputText,
          status,
          ...timingFieldsForSummary(snapshot)
        }
      };
    }

    case "tool-error": {
      // 工具执行抛出但未被 tool() 的 guard 包住的情况(ai 层错误)。
      const outputText = toErrorMessage(part.error);
      clock.delete(part.toolCallId);
      const snapshot = takeTiming(toolTiming, part.toolCallId);

      return {
        event: {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: outputText,
          status: "error",
          ...timingFields(snapshot)
        },
        toolCall: {
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          args: (part.input as Record<string, unknown>) ?? {},
          output: outputText,
          status: "error",
          ...timingFieldsForSummary(snapshot)
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
