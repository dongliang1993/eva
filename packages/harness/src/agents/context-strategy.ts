import type {
  ModelMessage,
  PrepareStepFunction,
  SystemModelMessage,
  ToolSet
} from "ai";

import { applyToolResultBudget } from "../context/tool-result-budget.js";
import {
  applyProactiveLoopCompactWithStats,
  applyReactiveLoopCompactWithStats,
  type RuntimeCompactResult
} from "../context/runtime-compact.js";
import type { ContextWindowPolicy } from "../context/policy.js";

export interface ContextStrategyOptions {
  readonly policy: ContextWindowPolicy;
  /** 固定 system prompt(始终作为 instructions 的第一条)。 */
  readonly systemPrompt: SystemModelMessage;
  /** 运行时固定前缀(context 消息)的条数,compact 不会动它们。 */
  readonly prefixMessageCount: number;
  /** compact 真的发生时回调,用来打 observer 事件。 */
  readonly onCompacted: (result: RuntimeCompactResult) => void;
}

/**
 * 每一步进模型前套的两道上下文防线(docs 14 §4.3):
 *   1. tool-result budget —— 单条工具输出超预算就截断并落盘到 tool-overflow
 *   2. proactive compact —— 整体接近上下文窗口就把中段折叠成 Runtime summary
 *
 * 再把 system 消息上提到 instructions:compact 产出的 Runtime summary 是
 * system 角色,插在历史中间。有的 OpenAI-compatible 供应商不接受中途
 * system 消息,上提是所有 provider 都成立的写法。
 * (ai@7 的 allowSystemInMessages 能让它留在原位,我们刻意不依赖它。)
 *
 * system prompt 始终是 instructions 的第一条 —— 它不进 messages(streamText
 * 顶层 messages 不允许 system 角色,校验在 prepareStep 之前)。
 */
export const createPrepareStep = <TOOLS extends ToolSet>(
  options: ContextStrategyOptions
): PrepareStepFunction<TOOLS> => ({ messages }) => {
  const budgeted = applyToolResultBudget(messages, options.policy);
  const compaction = applyProactiveLoopCompactWithStats(
    budgeted,
    options.prefixMessageCount,
    options.policy
  );

  if (compaction.changed) {
    options.onCompacted(compaction);
  }

  const instructions: SystemModelMessage[] = [options.systemPrompt];
  const rest: ModelMessage[] = [];

  for (const message of compaction.messages) {
    if (message.role === "system") {
      instructions.push(message as SystemModelMessage);
    } else {
      rest.push(message);
    }
  }

  return { instructions, messages: rest };
};

/** 触发 max-output 续写时追加的用户消息。 */
export const MAX_OUTPUT_CONTINUATION_MESSAGE =
  "Continue directly. Do not apologize. Do not repeat previous content.";

export const shouldContinueForMaxOutput = (
  finishReason: string,
  usedRecoveries: number,
  policy: ContextWindowPolicy
): boolean =>
  finishReason === "length" && usedRecoveries < policy.maxOutputRecoveryLimit;

/**
 * reactive compact 在 lead-agent 的 catch 里直接用 —— 不再包一层。
 * 返回的 messages 由调用方赋回 state.messages。
 */
export { applyReactiveLoopCompactWithStats };