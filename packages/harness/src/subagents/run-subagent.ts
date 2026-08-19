import type { ModelMessage } from "ai";

import type { Agent, AgentToolCallResult } from "../agents/types.js";
import type { StreamToolCallSummary } from "@eva/shared";
import type { SubagentEventSink } from "./types.js";

/**
 * 前台执行一个子代理(fork)。
 *
 * agent 已经是"assemble 好的成品"(工具槽模型 + 角色白名单工具 + 角色 system prompt),
 * 由 server 层的 subagent 工厂在 Step 4 搭好 —— 这里只负责跑 + 广播。
 *
 * 这是唯一的"事件信封注入点":主线程永远拿不到裸事件,只拿包裹了
 * taskId / parentToolCallId 的 SubagentEvent。这样阀2("子代理中间步骤不进主模型上下文")
 * 在消息层保证之外,还多一层类型护栏 —— runSubagent 之外的代码根本没有把
 * 子代理事件传出去的通路。
 *
 * 不在这里 persist:子代理消息落库、任务 settle 都是 server 层(Task 工具/recorder)的事。
 * 失败与超时也由调用方 settle —— 这里只负责把结果播出去。
 */
export const runSubagent = async (
  input: RunSubagentInput
): Promise<void> => {
  const { agent, taskId, parentToolCallId, subagentType, description, messages, abortSignal, maxSteps, onEvent } = input;
  const emit = onEvent
    ? (event: Parameters<SubagentEventSink>[0]) => onEvent(event)
    : undefined;

  try {
    const outcome = await agent.invoke({
      messages: messages as ModelMessage[],
      ...(abortSignal !== undefined ? { abortSignal } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {})
    });

    emit?.({
      taskId,
      parentToolCallId,
      subagentType,
      description,
      event: {
        type: "finish",
        text: outcome.text,
        toolCalls: outcome.toolCalls.map(toStreamToolCallSummary),
        finishReason: "stop"
      }
    });
  } catch (error) {
    emit?.({
      taskId,
      parentToolCallId,
      subagentType,
      description,
      event: {
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error"
      }
    });
  }
};

/** AgentToolCallResult → StreamToolCallSummary:后者 toolCallId 必填,SDK 归纳自 stream。 */
const toStreamToolCallSummary = (call: AgentToolCallResult): StreamToolCallSummary => ({
  toolName: call.toolName,
  toolCallId: call.toolCallId ?? call.toolName,
  args: call.args,
  output: call.output,
  status: call.status
});

/** runSubagent 的最小输入 —— 从 RunSubagentInput 里抽"跑什么"那部分,装配信息留在 Step 4。 */
export interface RunSubagentInput {
  readonly agent: Agent;
  readonly taskId: string;
  readonly parentToolCallId: string;
  readonly subagentType: string;
  readonly description: string;
  readonly messages: readonly ModelMessage[];
  readonly abortSignal?: AbortSignal;
  readonly maxSteps?: number;
  readonly onEvent?: SubagentEventSink;
}
