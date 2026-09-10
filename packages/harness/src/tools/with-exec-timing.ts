import type { AgentRunInput } from "../agents/types.js";
import type { AgentTool } from "./build-tool.js";
import { TOOL_CALL_ABORTED_OUTPUT } from "./build-tool.js";
import type { ToolTimingState } from "./tool-timing.js";

/** Measure execution after approval and queue waits. Persistence errors propagate. */
export const withExecTiming = (
  agentTool: AgentTool,
  timing: ToolTimingState,
  onToolExecution?: AgentRunInput["onToolExecution"]
): AgentTool => {
  const inner = agentTool.tool;
  const execute = inner.execute;
  if (typeof execute !== "function") return agentTool;
  return {
    ...agentTool,
    tool: {
      ...inner,
      execute: async (input: unknown, options?: unknown) => {
        const opts = options as { toolCallId?: string; abortSignal?: AbortSignal } | undefined;
        const toolCallId = opts?.toolCallId;
        opts?.abortSignal?.throwIfAborted();
        if (toolCallId) onToolExecution?.({ type: "started", toolCallId, toolName: agentTool.name, input });
        const startedAt = Date.now();
        let output: unknown;
        try {
          output = await execute(input as never, options as never);
        } catch (error) {
          if (toolCallId) onToolExecution?.({
            type: "failed", toolCallId,
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        } finally {
          if (toolCallId) timing.record(toolCallId, "exec", Date.now() - startedAt, {
            aborted: opts?.abortSignal?.aborted === true &&
              (output === undefined || output === TOOL_CALL_ABORTED_OUTPUT)
          });
        }
        if (toolCallId) onToolExecution?.({ type: "completed", toolCallId, output });
        return output;
      }
    } as typeof inner
  };
};
