import { resultMessage, userMessage } from "../query/messages.js";
import type { HarnessMessage, ToolTiming } from "../query/types.js";
import type { ToolTimingMutable } from "../query/tool-call.js";
import { TOOL_CALL_ABORTED_OUTPUT } from "../tools/tool.js";
import type { AgentObserver } from "./observer.js";

/**
 * abort 时对在飞工具的补发:把已发起、未收口的调用确定性补成取消结果。
 *
 * 在飞台账 = timings 里还留着的条目(正常路径 tool-result 时被 finishTurn 消费后
 * clear;没清掉的就是「已派发、没收口」)。不伪造三段计时:只标 aborted。
 */
export interface AbortInFlightInput {
  readonly timings: ReadonlyMap<string, ToolTimingMutable>;
  /** 在飞台账(流可见性):tool-call 块已见、result 未见。key=id,value=toolName。 */
  readonly pendingToolCalls: ReadonlyMap<string, string>;
  readonly step: number;
  readonly emit: AgentObserver;
}

export function* abortInFlightMessages(
  input: AbortInFlightInput,
): Generator<HarnessMessage> {
  const toolResults: {
    toolCallId: string;
    toolName: string;
    outputText: string;
    isError: boolean;
  }[] = [];
  const toolTiming: Record<string, ToolTiming> = {};

  for (const [toolCallId, toolName] of input.pendingToolCalls) {
    const timing = input.timings.get(toolCallId);
    input.emit({
      type: "tool_call_abandoned",
      step: input.step,
      toolName,
      toolCallId,
      waitedMs: timing
        ? timing.approval_wait_ms + timing.queue_wait_ms + timing.exec_ms
        : 0,
    });
    toolResults.push({
      toolCallId,
      toolName,
      outputText: TOOL_CALL_ABORTED_OUTPUT,
      isError: true,
    });
    toolTiming[toolCallId] = {
      ...(timing ?? {
        approval_wait_ms: 0, queue_wait_ms: 0, exec_ms: 0, aborted: false,
      }),
      aborted: true,
    };
  }

  if (toolResults.length === 0) return;

  yield userMessage({
    message: {
      role: "tool",
      content: toolResults.map((result) => ({
        type: "tool-result" as const,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        input: {},
        output: { type: "text" as const, value: result.outputText },
      })) as import("ai").ToolModelMessage["content"],
    },
    turn: input.step,
    toolTiming,
    parentToolUseID: null,
  });
}

export { resultMessage };
