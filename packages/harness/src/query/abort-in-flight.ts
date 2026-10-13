import { userMessage } from "./messages.js";
import type { HarnessMessage, ToolTiming } from "./types.js";
import type { ToolTimingMutable } from "./tool-call.js";
import { TOOL_CALL_ABORTED_OUTPUT } from "../tools/tool.js";

/**
 * abort 时对在飞工具的补发:把已发起、未收口的调用确定性补成取消结果。
 *
 * 在飞台账 = 流可见性(tool-call 块已见、result 未见)。不伪造三段计时:
 * 只标 aborted —— server 的 tool_call_abandoned 从 user.tool_timing[id].aborted 推。
 */
export interface AbortInFlightInput {
  readonly timings: ReadonlyMap<string, ToolTimingMutable>;
  /** 在飞台账(流可见性):tool-call 块已见、result 未见。key=id,value=toolName。 */
  readonly pendingToolCalls: ReadonlyMap<string, string>;
  readonly step: number;
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
