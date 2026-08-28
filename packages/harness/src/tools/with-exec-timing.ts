import type { AgentTool } from "./build-tool.js";
import { TOOL_CALL_ABORTED_OUTPUT } from "./build-tool.js";
import type { ToolTimingState } from "./tool-timing.js";

/**
 * 真实执行时间(T50):包住工具 execute 整体 —— buildTool 内的
 * Promise.race(definition.execute, abortFallback) 也包含在内,abort 抢先时
 * 记的是「到被中止为止」的执行时长,并在快照里标 execAborted。
 *
 * 统一在这一层装配,不让每个 Tool 自己实现 —— MCP 工具、fs 工具、plan-weave
 * 工具只要过 createAgent 就被同一层覆盖,没有「第一个漏的就成了黑洞」。
 * (additionalTools 在 stream() 期注入、不经过 createAgent 包装,是已知的例外,
 * 它们的快照取全 0。)
 *
 * abort 判定:race 兜底返回的是固定哨兵文案且 signal 已 aborted ——
 * 业务 execute 不可能恰好产出同一文案(哨兵是本文件的内部常量)。
 */
export const withExecTiming = (
  agentTool: AgentTool,
  timing: ToolTimingState
): AgentTool => {
  const inner = agentTool.tool;
  const innerExecute = inner.execute;

  if (typeof innerExecute !== "function") {
    return agentTool;
  }

  return {
    ...agentTool,
    tool: {
      ...inner,
      execute: async (input: unknown, options?: unknown) => {
        const opts = options as
          | { toolCallId?: string; abortSignal?: AbortSignal }
          | undefined;
        const toolCallId = opts?.toolCallId;
        const startedAt = Date.now();
        try {
          const output = await innerExecute(input as never, options as never);
          if (toolCallId !== undefined) {
            timing.record(toolCallId, "exec", Date.now() - startedAt, {
              aborted:
                opts?.abortSignal?.aborted === true &&
                output === TOOL_CALL_ABORTED_OUTPUT
            });
          }
          return output;
        } catch (error) {
          // 异常路径也要记 —— 「到抛出为止」的时长(契约:异常与取消都要有事件)。
          if (toolCallId !== undefined) {
            timing.record(toolCallId, "exec", Date.now() - startedAt, {
              aborted: opts?.abortSignal?.aborted === true
            });
          }
          throw error;
        }
      }
    } as typeof inner
  };
};
