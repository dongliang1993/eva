import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import { isOverflowing } from "../packages/harness/src/context/runtime-compact.js";
import { resolveContextWindowPolicy } from "../packages/harness/src/context/policy.js";

// T36: compact 判定从 chars/4 估算换上一步真实 usage.inputTokens。
// 阈值 = contextWindow - reservedOutputTokens - loopCompactBufferTokens。
// contextWindow 128k / reserved 8k / buffer 12k → 阈值 108k。
const policy = resolveContextWindowPolicy({
  contextWindow: 128_000,
  reservedOutputTokens: 8_000,
  loopCompactBufferTokens: 12_000
});

/** 造 N 条短 user 消息(估算 token 远低于阈值)。 */
const shortMessages = (): ModelMessage[] => [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" }
];

describe("isOverflowing(T36 真实 usage 驱动)", () => {
  it("有上一步 usage 且超阈值 → 溢出", () => {
    // 真实 usage 120k > 阈值 108k,即便 messages 估算很小也应判溢出(用真值)
    expect(isOverflowing(shortMessages(), policy, 120_000)).toBe(true);
  });

  it("有上一步 usage 且低于阈值 → 不溢出", () => {
    expect(isOverflowing(shortMessages(), policy, 50_000)).toBe(false);
  });

  it("真值优先于估算:估算很大但真值小 → 不溢出", () => {
    // 造一个 chars/4 估算超阈值的消息串,但真值只有 50k → 应信真值不溢出
    const huge: ModelMessage[] = [
      { role: "user", content: "x".repeat(500_000) } // 估算 ~125k
    ];
    expect(isOverflowing(huge, policy, 50_000)).toBe(false);
  });

  it("真值优先于估算:估算很小但真值超阈值 → 溢出", () => {
    // 估算极小(两条短消息),但上一步真实 inputTokens 120k → 溢出
    expect(isOverflowing(shortMessages(), policy, 120_000)).toBe(true);
  });

  it("首步无 usage(未传)→ 退回估算,估算超阈值则溢出", () => {
    const huge: ModelMessage[] = [
      { role: "user", content: "x".repeat(500_000) } // 估算 ~125k > 108k
    ];
    expect(isOverflowing(huge, policy)).toBe(true);
  });

  it("首步无 usage(未传)→ 退回估算,估算低于阈值则不溢出", () => {
    expect(isOverflowing(shortMessages(), policy)).toBe(false);
  });

  it("边界:usage 恰好等于阈值 → 不溢出(需严格大于)", () => {
    expect(isOverflowing(shortMessages(), policy, 108_000)).toBe(false);
    expect(isOverflowing(shortMessages(), policy, 108_001)).toBe(true);
  });
});

describe("createPrepareStep 接线(T36 getter 取上一步真值)", () => {
  it("getter 返回超阈值真值 → 触发 compact(onCompacted 被调)", async () => {
    const { createPrepareStep } = await import(
      "../packages/harness/src/agents/context-strategy.js"
    );

    // getter 模拟 agent.onStepEnd 存的上一步真实 inputTokens(120k > 阈值 108k)
    let lastStepInputTokens: number | undefined = 120_000;
    let compactedCount = 0;

    const prepareStep = createPrepareStep({
      policy,
      systemPrompt: { role: "system", content: "sys" },
      prefixMessageCount: 0,
      onCompacted: () => { compactedCount += 1; },
      getLastStepInputTokens: () => lastStepInputTokens
    });

    // 多条短消息(估算远低于阈值)——若用估算不会压,用真值 120k 会压
    const messages: ModelMessage[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg ${i}`
    }));

    prepareStep({ messages } as never);
    expect(compactedCount).toBe(1);
  });

  it("getter 返回 undefined(首步)→ 退回估算兜底", async () => {
    const { createPrepareStep } = await import(
      "../packages/harness/src/agents/context-strategy.js"
    );

    let compactedCount = 0;
    const prepareStep = createPrepareStep({
      policy,
      systemPrompt: { role: "system", content: "sys" },
      prefixMessageCount: 0,
      onCompacted: () => { compactedCount += 1; },
      getLastStepInputTokens: () => undefined
    });

    // 估算超阈值(长消息)→ 即便无真值也应压
    const messages: ModelMessage[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(50_000) // 估算 ~150k > 108k
    }));

    prepareStep({ messages } as never);
    expect(compactedCount).toBe(1);
  });
});
