import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import { applyProactiveLoopCompactWithStats } from "../packages/harness/src/context/runtime-compact.js";
import { resolveContextWindowPolicy } from "../packages/harness/src/context/policy.js";

// T37: 压缩产出对齐 Alma —— <context_summary> user 消息 + 「不要从头再来」reminder + 六段摘要。
const policy = resolveContextWindowPolicy({
  contextWindow: 20, // 极小窗口,逼必然触发 compact(8 条估算 ~27 token > 20)
  reservedOutputTokens: 0,
  loopCompactBufferTokens: 0
});

/** 造一组会触发 compact 的 messages(prefix=0,远超小窗口)。 */
const bigMessages = (): ModelMessage[] => [
  { role: "user", content: "帮我重构 auth 模块" },
  { role: "assistant", content: "我先读一下 src/auth.ts" },
  { role: "user", content: "顺便加上刷新 token" },
  { role: "assistant", content: "读到一半发现 session 过期逻辑有 bug" },
  { role: "user", content: "对,就是那个 bug" },
  { role: "assistant", content: "修好了,现在跑测试" },
  { role: "user", content: "测试过了吗" },
  { role: "assistant", content: "全绿,准备提交" }
];

describe("T37 压缩产出格式", () => {
  it("compact 后产出 <context_summary> 的 user 消息(不再是 system)", () => {
    const result = applyProactiveLoopCompactWithStats(bigMessages(), 0, policy);
    expect(result.changed).toBe(true);

    const summary = result.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("<context_summary>")
    );
    expect(summary).toBeDefined();
    expect(summary?.role).toBe("user");
  });

  it("<context_summary> 内含六段结构标题", () => {
    const result = applyProactiveLoopCompactWithStats(bigMessages(), 0, policy);
    const summary = result.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("<context_summary>")
    );
    const text = typeof summary?.content === "string" ? summary.content : "";

    for (const section of [
      "Primary Request",
      "Key Technical Concepts",
      "Files and Code",
      "Errors and Fixes",
      "Problem Solving",
      "All User Messages"
    ]) {
      expect(text).toContain(section);
    }
  });

  it("summary 后带「不要从头再来」reminder", () => {
    const result = applyProactiveLoopCompactWithStats(bigMessages(), 0, policy);
    const reminder = result.messages.find(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        /do not start over|不要从头再来|continue from where/i.test(m.content)
    );
    expect(reminder).toBeDefined();
  });

  it("All User Messages 段保留被压缩的 user 消息原文", () => {
    const result = applyProactiveLoopCompactWithStats(bigMessages(), 0, policy);
    const summary = result.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("<context_summary>")
    );
    const text = typeof summary?.content === "string" ? summary.content : "";

    // 被压缩进 summary 的 user 消息(前几条,preservedTail 留了最后 4 条)原文不能丢。
    // bigMessages 8 条,preserve 4 → 压前 4 条,含 2 条 user:「帮我重构 auth 模块」「顺便加上刷新 token」。
    expect(text).toContain("帮我重构 auth 模块");
    expect(text).toContain("顺便加上刷新 token");
    // preservedTail 的 user 消息留在原位(messages 尾部),不进 summary 也正常。
    const tail = result.messages.filter((m) => m.role === "user" && m !== summary);
    expect(tail.some((m) => typeof m.content === "string" && m.content.includes("测试过了吗"))).toBe(true);
  });

  it("二次 compact 能识别旧 <context_summary> 并融入(不重复套娃)", () => {
    const first = applyProactiveLoopCompactWithStats(bigMessages(), 0, policy);
    expect(first.changed).toBe(true);
    // 第一次压缩后:summary(user) + reminder(system) + preservedTail
    expect(
      first.messages.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("<context_summary>")).length
    ).toBe(1);

    // 第二次:在第一次结果上追加足够多的新消息,确保越过阈值再次触发。
    const more: ModelMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `后续讨论内容 ${i} 需要被压缩进新的 summary`
    }));
    const second = applyProactiveLoopCompactWithStats([...first.messages, ...more], 0, policy);
    expect(second.changed).toBe(true);

    // 旧 summary 被识别并融入新 summary(同一条),reminder 也只有一条 —— 不套娃。
    const summaries = second.messages.filter(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("<context_summary>")
    );
    expect(summaries).toHaveLength(1);
    const reminders = second.messages.filter(
      (m) => m.role === "system" && typeof m.content === "string" && /do not start over|do NOT start over/i.test(m.content)
    );
    expect(reminders).toHaveLength(1);
  });
});

describe("T37 context-strategy 上提适配", () => {
  it("<context_summary>(user)留 messages,reminder(system)上提 instructions", async () => {
    const { createPrepareStep } = await import(
      "../packages/harness/src/agents/context-strategy.js"
    );

    let compacted = false;
    const prepareStep = createPrepareStep({
      policy,
      systemPrompt: { role: "system", content: "sys" },
      prefixMessageCount: 0,
      onCompacted: () => { compacted = true; }
      // 不传 getLastStepInputTokens → 走估算,长消息必然超小窗口
    });

    const messages: ModelMessage[] = [
      { role: "user", content: "帮我重构 auth 模块,要支持刷新 token 和记住我" },
      { role: "assistant", content: "我先读 src/auth.ts 看一下现状" },
      { role: "user", content: "顺便把 session 过期 bug 也修了" },
      { role: "assistant", content: "看到问题了,exp 判断反了" },
      { role: "user", content: "对" },
      { role: "assistant", content: "修好了" },
      { role: "user", content: "跑测试" },
      { role: "assistant", content: "全绿" }
    ];

    const out = prepareStep({ messages } as never) as {
      instructions: Array<{ role: string; content: string }>;
      messages: ModelMessage[];
    };

    expect(compacted).toBe(true);
    // summary(user)留在 messages,不被上提
    expect(
      out.messages.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("<context_summary>")
      )
    ).toBe(true);
    expect(
      out.instructions.some((i) => typeof i.content === "string" && i.content.startsWith("<context_summary>"))
    ).toBe(false);
    // reminder(system)上提到 instructions
    expect(
      out.instructions.some((i) => /do NOT start over/i.test(typeof i.content === "string" ? i.content : ""))
    ).toBe(true);
  });
});
