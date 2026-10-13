import { describe, expect, it } from "vitest";

import { resolveContextWindowPolicy } from "../../../packages/harness/src/context/policy.js";
import {
  buildMaxOutputRecovery,
  planReactiveRecovery,
  shouldRecoverMaxOutput,
} from "../../../packages/harness/src/context/recovery-policy.js";

describe("Agent recovery policy", () => {
  it("reactive compact 只为上下文超限且尚未恢复过的工作集制定重试", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message-${index} ${"x".repeat(500)}`,
    }));
    const first = planReactiveRecovery({
      error: new Error("context window exceeded"),
      messages,
      prefixMessageCount: 0,
      hasCompactedReactively: false,
    });

    expect(first.compactCandidate).toBe(true);
    expect(first.compaction?.changed).toBe(true);
    expect(first.compaction?.messages.length).toBeLessThan(messages.length);

    const second = planReactiveRecovery({
      error: new Error("context window exceeded"),
      messages,
      prefixMessageCount: 0,
      hasCompactedReactively: true,
    });
    expect(second.compaction).toBeUndefined();
  });

  it("max-output 恢复保留累计正文并追加固定续写消息", () => {
    // 字段随 T4 上移改名:maxOutputRecoveries → maxOutputRecoveryLimit(policy 唯一命名)。
    const policy = resolveContextWindowPolicy({ maxOutputRecoveryLimit: 1 });
    expect(
      shouldRecoverMaxOutput({
        finishReason: "length",
        recoveries: 0,
        policy,
      }),
    ).toBe(true);

    const recovery = buildMaxOutputRecovery({
      responseMessages: [{ role: "assistant", content: "part one" }],
      continuedText: "before ",
      text: "part one",
      recoveries: 0,
    });
    expect(recovery.continuedText).toBe("before part one");
    expect(recovery.recoveries).toBe(1);
    expect(recovery.messages.at(-1)).toMatchObject({ role: "user" });
  });

});
