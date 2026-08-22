import type { AgentTool } from "./build-tool.js";
import { isSafeReadOnlyCommand } from "./safe-readonly.js";
import type { RequestApproval } from "../agents/types.js";

export const APPROVAL_DENIED_PREFIX = "[Approval Denied]";

const deniedMessage = (toolName: string): string =>
  `${APPROVAL_DENIED_PREFIX} The user rejected the \`${toolName}\` call. `
  + "Do not retry the same call. Explain what you wanted to do and ask the user how to proceed.";

/**
 * 危险工具的审批闸门(docs/architecture/14 §4.4)。
 *
 * 为什么包在 execute 外层而不用 SDK 的 toolApproval 两轮调用:两轮调用需要手工
 * 缝 assistant(tool-call) + tool(approval-response) 消息序列,缝错会重复正文甚至
 * 死循环;而且每次审批要多付一次完整模型调用。包装法只有一次模型调用,
 * abort 时能被 cancelByRun 统一 reject。
 */
export const withApproval = (
  agentTool: AgentTool,
  requestApproval: RequestApproval
): AgentTool => {
  if (agentTool.needsApproval !== true) {
    return agentTool;
  }

  const inner = agentTool.tool;
  const innerExecute = inner.execute;

  if (typeof innerExecute !== "function") {
    return agentTool;
  }

  return {
    ...agentTool,
    tool: {
      ...inner,
      execute: async (input: unknown, options) => {
        // T29:bash 只读命令直放,不进审批(docs/plans/r7/T29 §2.2)。
        // 判定与 server 台账(runs.ts)共用同一个 isSafeReadOnlyCommand,不会漂移。
        if (agentTool.name === "bash") {
          const cmd = (input as Record<string, unknown>)?.command;
          if (typeof cmd === "string" && isSafeReadOnlyCommand(cmd)) {
            return innerExecute(input as never, options);
          }
        }

        const approved = await requestApproval({
          toolName: agentTool.name,
          toolCallId: options.toolCallId,
          args: (input as Record<string, unknown>) ?? {}
        });

        if (!approved) {
          return deniedMessage(agentTool.name);
        }

        return innerExecute(input as never, options);
      }
    } as typeof inner
  };
};