import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";

import { createAgent } from "../../../packages/harness/src/agents/agent.js";
import type { AgentStreamEvent } from "../../../packages/harness/src/agents/types.js";
import type { RunInjectedNotice } from "@eva/shared";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

/** 每次调用都产一段纯文本并 stop —— 第 N 圈说第 N 句话,便于断言"不重复正文"。 */
const talkingModel = (): { model: MockLanguageModelV4; calls: () => number } => {
  let callIndex = 0;

  const model = new MockLanguageModelV4({
    doStream: async () => {
      const call = callIndex;
      callIndex += 1;

      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: `${call}` },
            { type: "text-delta", id: `${call}`, delta: `turn${call}` },
            { type: "text-end", id: `${call}` },
            { type: "finish", finishReason: "stop", usage }
          ]
        })
      };
    }
  });

  return { model, calls: () => callIndex };
};

const notice = (over: Partial<RunInjectedNotice> = {}): RunInjectedNotice => ({
  kind: "reported",
  taskId: "t_abc",
  parentToolCallId: "call_00",
  description: "深挖 apps/server",
  text: "Background subagent t_abc (深挖 apps/server) reported:\n\n结论如下",
  ...over
});

const collect = async (
  stream: AsyncIterable<AgentStreamEvent>
): Promise<AgentStreamEvent[]> => {
  const out: AgentStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
};

describe("Agent 子代理通知注入 (S7 push)", () => {
  it("drainNotices 返回通知 → 再跑一圈,且 yield 出消息边界帧", async () => {
    const { model, calls } = talkingModel();
    const agent = createAgent({ model, tools: [], systemPrompt: "sys" });
    let drained = 0;

    const events = await collect(
      agent.stream({
        messages: [{ role: "user", content: "hi" }],
        drainNotices: async () => {
          drained += 1;
          // 第一次给一条通知,之后没有了 —— 否则会一直续跑。
          return drained === 1 ? [notice()] : [];
        }
      })
    );

    const injected = events.filter((e) => e.type === "notice-injected");
    expect(injected).toHaveLength(1);
    expect(calls()).toBe(2); // 注入后确实又发起了一次模型调用

    const finish = events.find((e) => e.type === "finish");
    expect(finish?.type).toBe("finish");
  });

  it("续跑的 finish 只含新正文,不重复注入前那段(continuedText 必须清空)", async () => {
    const { model } = talkingModel();
    const agent = createAgent({ model, tools: [], systemPrompt: "sys" });
    let drained = 0;

    const events = await collect(
      agent.stream({
        messages: [{ role: "user", content: "hi" }],
        drainNotices: async () => {
          drained += 1;
          return drained === 1 ? [notice()] : [];
        }
      })
    );

    const finish = events.find((e) => e.type === "finish");
    if (finish?.type !== "finish") throw new Error("no finish");

    // 第二圈说的是 turn1;若 continuedText 没清空会变成 "turn0turn1"。
    expect(finish.text).toBe("turn1");
    expect(finish.text).not.toContain("turn0");
  });

  it("没有通知 → 正常终态,不额外调用模型", async () => {
    const { model, calls } = talkingModel();
    const agent = createAgent({ model, tools: [], systemPrompt: "sys" });

    const events = await collect(
      agent.stream({
        messages: [{ role: "user", content: "hi" }],
        drainNotices: async () => []
      })
    );

    expect(events.some((e) => e.type === "notice-injected")).toBe(false);
    expect(calls()).toBe(1);
  });

  it("不传 drainNotices → 行为与改动前一致(向后兼容)", async () => {
    const { model, calls } = talkingModel();
    const agent = createAgent({ model, tools: [], systemPrompt: "sys" });

    const events = await collect(
      agent.stream({ messages: [{ role: "user", content: "hi" }] })
    );

    expect(events.some((e) => e.type === "notice-injected")).toBe(false);
    expect(calls()).toBe(1);
  });

  it("通知源源不断也不会无限续跑(MAX_NOTICE_ROUNDS 封顶)", async () => {
    const { model, calls } = talkingModel();
    const agent = createAgent({ model, tools: [], systemPrompt: "sys" });

    const events = await collect(
      agent.stream({
        messages: [{ role: "user", content: "hi" }],
        // 永远有新通知 —— 病态场景(子代理互相唤起)。
        drainNotices: async () => [notice()]
      })
    );

    const injected = events.filter((e) => e.type === "notice-injected");
    expect(injected).toHaveLength(4); // MAX_NOTICE_ROUNDS
    expect(calls()).toBe(5); // 首轮 + 4 圈续跑
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("注入的通知文本进了下一轮的 messages(模型真能看到)", async () => {
    const seen: string[] = [];
    let callIndex = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        callIndex += 1;
        seen.push(JSON.stringify(prompt));
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "ok" },
              { type: "text-end", id: "1" },
              { type: "finish", finishReason: "stop", usage }
            ]
          })
        };
      }
    });
    const agent = createAgent({ model, tools: [], systemPrompt: "sys" });
    let drained = 0;

    await collect(
      agent.stream({
        messages: [{ role: "user", content: "hi" }],
        drainNotices: async () => {
          drained += 1;
          return drained === 1 ? [notice()] : [];
        }
      })
    );

    expect(callIndex).toBe(2);
    expect(seen[1]).toContain("结论如下");
    expect(seen[1]).toContain("深挖 apps/server");
  });
});
