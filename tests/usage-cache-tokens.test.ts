/**
 * T40:cache 五元组接通。
 *
 * SDK v7 的 LanguageModelUsage 已标准化 inputTokenDetails.{cacheReadTokens,
 * cacheWriteTokens} + outputTokenDetails.reasoningTokens(ai@7.0.64)。Eva 的
 * readTokenUsage 原本只取 input/output/total,导致 cached/reasoning 永远写 0、
 * cache_write 无处可存。这里验证整条链:读明细 → 累加 → 透传 StreamTokenUsage。
 */
import { describe, expect, it } from "vitest";

import {
  addTokenUsage,
  readTokenUsage,
  toStreamTokenUsage,
  type TokenUsage,
} from "../packages/harness/src/agents/observer.js";

/** SDK LanguageModelUsage 的最小形状(含 cache/reasoning 明细)。 */
const sdkUsage = (over: Record<string, unknown> = {}) => ({
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  ...over,
});

describe("readTokenUsage 读 cache/reasoning 明细", () => {
  it("带 cache/reasoning 明细 → 读出 cached/cacheWrite/reasoning", () => {
    const u = readTokenUsage(
      sdkUsage({
        inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 20 },
        outputTokenDetails: { reasoningTokens: 10 },
      }) as never,
    );
    expect(u).toMatchObject({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 30,
      cacheWriteTokens: 20,
      reasoningTokens: 10,
    });
  });

  it("不带明细(非 cache 模型)→ 三字段 undefined,不写成 0", () => {
    const u = readTokenUsage(sdkUsage() as never);
    expect(u).toMatchObject({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    expect(u?.cachedInputTokens).toBeUndefined();
    expect(u?.cacheWriteTokens).toBeUndefined();
    expect(u?.reasoningTokens).toBeUndefined();
  });

  it("明细字段缺个别 → 缺的留 undefined", () => {
    const u = readTokenUsage(
      sdkUsage({
        inputTokenDetails: { cacheReadTokens: 5 }, // 无 cacheWriteTokens
      }) as never,
    );
    expect(u?.cachedInputTokens).toBe(5);
    expect(u?.cacheWriteTokens).toBeUndefined();
  });

  it("全零 usage → 返回 undefined(原有契约不破)", () => {
    expect(
      readTokenUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never),
    ).toBeUndefined();
  });
});

describe("addTokenUsage 累加三新字段", () => {
  it("两边都有 → 逐字段相加", () => {
    const a: TokenUsage = {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      cachedInputTokens: 10,
      cacheWriteTokens: 20,
      reasoningTokens: 30,
    };
    const b: TokenUsage = {
      promptTokens: 4,
      completionTokens: 5,
      totalTokens: 6,
      cachedInputTokens: 1,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    };
    expect(addTokenUsage(a, b)).toEqual({
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 9,
      cachedInputTokens: 11,
      cacheWriteTokens: 22,
      reasoningTokens: 33,
    });
  });

  it("单边 undefined → 保留另一边;全 undefined → 字段保持 undefined", () => {
    const base: TokenUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    const withCache: TokenUsage = { ...base, cacheWriteTokens: 7 };
    expect(addTokenUsage(base, withCache).cacheWriteTokens).toBe(7);
    expect(addTokenUsage(base, base).cacheWriteTokens).toBeUndefined();
    expect(addTokenUsage(base, base).cachedInputTokens).toBeUndefined();
  });
});

describe("toStreamTokenUsage 透传 cache/reasoning", () => {
  it("带明细 → StreamTokenUsage 含 cacheWriteTokens/cachedInputTokens/reasoningTokens", () => {
    const s = toStreamTokenUsage({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 30,
      cacheWriteTokens: 20,
      reasoningTokens: 10,
    });
    expect(s).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 30,
      cacheWriteTokens: 20,
      reasoningTokens: 10,
    });
  });

  it("不带明细 → 只透 input/output/total,不写 undefined 键", () => {
    const s = toStreamTokenUsage({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    expect(s).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect("cacheWriteTokens" in s).toBe(false);
  });
});
