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

export interface ContextStrategyOptions<TOOLS extends ToolSet = ToolSet> {
  readonly policy: ContextWindowPolicy;
  /** 固定 system prompt(始终作为 instructions 的第一条)。 */
  readonly systemPrompt: SystemModelMessage;
  /** 运行时固定前缀(context 消息)的条数,compact 不会动它们。 */
  readonly prefixMessageCount: number;
  /** compact 真的发生时回调,用来打 observer 事件。 */
  readonly onCompacted: (result: RuntimeCompactResult) => void;
  /**
   * T36: 取上一步真实 usage.inputTokens(getter 每步调一次取最新值,不是构造时快照)。
   * 首步无值返回 undefined,判定退回估算。不传则始终走估算(向后兼容)。
   */
  readonly getLastStepInputTokens?: () => number | undefined;
  /**
   * T43:每步最新的 activeTools(discovery mode 下含 tool_search 激活结果)。
   * 返回 undefined = 不限制。
   */
  readonly getActiveTools?: () => readonly (keyof TOOLS & string)[] | undefined;
  /** T43:degraded/discovery 时追加的 system notice(跟在主 system prompt 后)。 */
  readonly extraInstructions?: SystemModelMessage[];
  /**
   * T45a:每步动态追加的 instructions(plan gate reminder)。与 extraInstructions 取并集;
   * getter 每步调一次,plan gate 中途 enter/exit 才能被下一步看见。
   */
  readonly getExtraInstructions?: () => readonly SystemModelMessage[];
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
  options: ContextStrategyOptions<TOOLS>
): PrepareStepFunction<TOOLS> => ({ messages }) => {
  const budgeted = applyToolResultBudget(messages, options.policy);
  const compaction = applyProactiveLoopCompactWithStats(
    budgeted,
    options.prefixMessageCount,
    options.policy,
    options.getLastStepInputTokens?.()
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

  const activeTools = options.getActiveTools?.();

  return {
    instructions: [
      ...instructions,
      ...(options.extraInstructions ?? []),
      ...(options.getExtraInstructions?.() ?? []),
    ],
    messages: rest,
    ...(activeTools !== undefined ? { activeTools } : {}),
  };
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
 * reactive compact 在 agent.ts 的 catch 里直接用 —— 不再包一层。
 * 返回的 messages 由调用方赋回 state.messages。
 */
export { applyReactiveLoopCompactWithStats };