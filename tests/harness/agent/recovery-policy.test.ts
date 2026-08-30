import { describe, expect, it } from "vitest";

import { resolveContextWindowPolicy } from "../../../packages/harness/src/context/policy.js";
import {
  MAX_NOTICE_ROUNDS,
  buildMaxOutputRecovery,
  buildNoticeRecovery,
  canDrainNotices,
  planReactiveRecovery,
  shouldRecoverMaxOutput,
} from "../../../packages/harness/src/agents/recovery-policy.js";

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
    const policy = resolveContextWindowPolicy({ maxOutputRecoveries: 1 });
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

  it("notice 恢复受步数与轮数上限约束，并把多条通知合成下一条用户消息", () => {
    expect(
      canDrainNotices({
        stepsUsed: 1,
        maxSteps: 2,
        noticeRounds: MAX_NOTICE_ROUNDS - 1,
        hasDrainNotices: true,
      }),
    ).toBe(true);
    expect(
      canDrainNotices({
        stepsUsed: 1,
        maxSteps: 2,
        noticeRounds: MAX_NOTICE_ROUNDS,
        hasDrainNotices: true,
      }),
    ).toBe(false);

    const recovery = buildNoticeRecovery({
      responseMessages: [{ role: "assistant", content: "waiting" }],
      notices: [
        { taskId: "a", text: "first" },
        { taskId: "b", text: "second" },
      ],
      noticeRounds: 0,
    });
    expect(recovery.noticeRounds).toBe(1);
    expect(recovery.messages.at(-1)).toEqual({
      role: "user",
      content: "first\n\nsecond",
    });
  });
});
