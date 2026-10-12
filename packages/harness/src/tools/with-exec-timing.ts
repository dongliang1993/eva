import type { AgentRunInput } from "../agents/types.js";
import type { PipelineTool } from "./tool.js";
import {
  textOf,
  TOOL_CALL_ABORTED_OUTPUT,
} from "./tool.js";
import type { ToolExtra } from "../query/types.js";
import type { ToolResult } from "../query/types.js";
import type { ToolTimingState } from "./tool-timing.js";

/** Measure execution after approval and queue waits. Persistence errors propagate. */
export const withExecTiming = (
  pipelineTool: PipelineTool,
  timing: ToolTimingState,
  onToolExecution?: AgentRunInput["onToolExecution"]
): PipelineTool => {
  const innerExecute = pipelineTool.execute;

  const execute: PipelineTool["execute"] = async (input, extra: ToolExtra) => {
    const toolCallId = extra.toolUseID;
    const signal = extra.signal;
    signal.throwIfAborted();
    onToolExecution?.({ type: "started", toolCallId, toolName: pipelineTool.name, input });
    const startedAt = Date.now();
    let output: ToolResult | undefined;
    try {
      output = await innerExecute(input, extra);
    } catch (error) {
      if (toolCallId) onToolExecution?.({
        type: "failed", toolCallId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      if (toolCallId) timing.record(toolCallId, "exec", Date.now() - startedAt, {
        aborted: signal.aborted === true &&
          (output === undefined || textOf(output) === TOOL_CALL_ABORTED_OUTPUT)
      });
    }
    if (toolCallId) onToolExecution?.({ type: "completed", toolCallId, output });
    return output;
  };

  return { ...pipelineTool, execute };
};
