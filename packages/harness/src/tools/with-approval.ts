import type { PipelineTool } from "./tool.js";
import type { ToolExtra } from "../query/types.js";
import { isSafeReadOnlyCommand } from "./safe-readonly.js";
import type { AgentObserver } from "../agents/observer.js";
import type { RequestApproval } from "../agents/types.js";
import type { ToolTimingState } from "./tool-timing.js";

export const APPROVAL_DENIED_PREFIX = "[Approval Denied]";

const deniedMessage = (toolName: string): string =>
  `${APPROVAL_DENIED_PREFIX} The user rejected the \`${toolName}\` call. `
  + "Do not retry the same call. Explain what you wanted to do and ask the user how to proceed.";

/**
 * 危险工具的审批闸门。
 *
 * 为什么包在 execute 外层而不用 SDK 的 toolApproval 两轮调用:两轮调用需要手工
 * 缝 assistant(tool-call) + tool(approval-response) 消息序列,缝错会重复正文甚至
 * 死循环;而且每次审批要多付一次完整模型调用。包装法只有一次模型调用,
 * abort 时能被 cancelByRun 统一 reject。
 *
 * 传了 observer 就在问与答两个点发 approval_asked / approval_decided ——
 * 事件的身份(run/agent)由 observer 的绑定关系承担,这里不发也能跑。
 */
export const withApproval = (
  pipelineTool: PipelineTool,
  requestApproval: RequestApproval,
  observer?: AgentObserver,
  timing?: ToolTimingState
): PipelineTool => {
  if (pipelineTool.needsApproval !== true) {
    return pipelineTool;
  }

  const innerExecute = pipelineTool.execute;

  const execute: PipelineTool["execute"] = async (input, extra: ToolExtra) => {
    // bash 只读命令直放,不进审批。
    // 判定与 server 台账(runs.ts)共用同一个 isSafeReadOnlyCommand,不会漂移。
    if (pipelineTool.name === "bash") {
      const cmd = (input as Record<string, unknown>)?.command;
      if (typeof cmd === "string" && isSafeReadOnlyCommand(cmd)) {
        return innerExecute(input, extra);
      }
    }

    const toolCallId: string = extra.toolUseID;
    observer?.({ type: "approval_asked", toolName: pipelineTool.name, toolCallId });
    // 审批等待单独成段 —— 它动辄秒级/分钟级,混进工具耗时就什么性能结论都得不出。
    const approvalStart = Date.now();
    const approved = await requestApproval({
      toolName: pipelineTool.name,
      toolCallId,
      args: (input as Record<string, unknown>) ?? {}
    });
    timing?.record(toolCallId, "approval", Date.now() - approvalStart);
    observer?.({
      type: "approval_decided",
      toolName: pipelineTool.name,
      toolCallId,
      approved
    });

    if (!approved) {
      return { content: [{ type: "text", text: deniedMessage(pipelineTool.name) }] };
    }

    return innerExecute(input, extra);
  };

  return { ...pipelineTool, execute };
};
