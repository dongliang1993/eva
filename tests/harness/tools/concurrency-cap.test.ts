import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { createAgent } from "../../../packages/harness/src/agents/agent.js";
import type { AgentStreamEvent } from "../../../packages/harness/src/agents/types.js";
import { buildTool } from "../../../packages/harness/src/tools/build-tool.js";
import { createWebFetchTool } from "../../../packages/harness/src/index.js";
import { Semaphore } from "../../../packages/harness/src/tools/concurrency-cap.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

// ---------------------------------------------------------------------------
// Semaphore 语义
// ---------------------------------------------------------------------------

describe("Semaphore(T24 只读并发帽)", () => {
  it("limit 2:第 3 个 acquire 排队,release 后放行", async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();

    let thirdDone = false;
    const third = sem.acquire().then((r) => {
      thirdDone = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(thirdDone).toBe(false);

    r1();
    const r3 = await third;
    expect(thirdDone).toBe(true);
    r2();
    r3();
  });

  it("FIFO:3 个 waiter 按发起顺序依次拿到", async () => {
    const sem = new Semaphore(1);
    const r0 = await sem.acquire();

    const order: number[] = [];
    const pending = [1, 2, 3].map((i) =>
      sem.acquire().then((release) => {
        order.push(i);
        release();
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);

    r0();
    await Promise.all(pending);
    expect(order).toEqual([1, 2, 3]);
  });

  it("release 双调不塌:active 计数不变,后续 acquire 不被多放", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release(); // 幂等:第二次是 no-op
    release();

    // 双调没有把 active 扣成负数 → 下一个 acquire 立即拿到;
    // 也没有凭空多归还 → 再来两个 acquire 时第二个必须排队。
    const r1 = await sem.acquire();
    let secondDone = false;
    const second = sem.acquire().then((r) => {
      secondDone = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondDone).toBe(false);
    r1();
    await second;
  });

  it("limit 1 串行语义:进入区间不重叠", async () => {
    const sem = new Semaphore(1);
    const overlaps: string[] = [];
    let current: string | undefined;

    const run = async (id: string) => {
      const release = await sem.acquire();
      if (current !== undefined) overlaps.push(`${current}×${id}`);
      current = id;
      await new Promise((r) => setTimeout(r, 10));
      current = undefined;
      release();
    };
    await Promise.all(["a", "b", "c"].map(run));
    expect(overlaps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 装配层帽(createAgent)
// ---------------------------------------------------------------------------

/** N 个 tool-call 一步齐发、下一步收尾的假模型。 */
const multiToolCallModel = (toolNames: string[]): MockLanguageModelV4 => {
  let callIndex = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const call = callIndex;
      callIndex += 1;
      if (call === 0) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              ...toolNames.map((name, i) => ({
                type: "tool-input-start" as const,
                id: `tc-${i}`,
                toolName: name,
              })),
              ...toolNames.map((name, i) => ({
                type: "tool-call" as const,
                toolCallId: `tc-${i}`,
                toolName: name,
                input: JSON.stringify({ n: i }),
              })),
              { type: "finish", finishReason: "tool-calls", usage },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "done" },
            { type: "text-end", id: "1" },
            { type: "finish", finishReason: "stop", usage },
          ],
        }),
      };
    },
  });
};

/** 受控慢工具:进入/退出打点,resolve 挂 30ms。 */
const probeTool = (
  name: string,
  opts: { readOnly?: boolean; metrics: { active: number; max: number } },
) =>
  buildTool({
    name,
    description: `probe ${name}`,
    inputSchema: z.object({ n: z.number().optional() }),
    ...(opts.readOnly === true ? { readOnly: true } : {}),
    execute: async (input: { n?: number }) => {
      opts.metrics.active += 1;
      opts.metrics.max = Math.max(opts.metrics.max, opts.metrics.active);
      await new Promise((r) => setTimeout(r, 30));
      opts.metrics.active -= 1;
      return `${name}-${input.n ?? "?"}`;
    },
  });

const collectEvents = async (
  agent: ReturnType<typeof createAgent>,
): Promise<AgentStreamEvent[]> => {
  const events: AgentStreamEvent[] = [];
  for await (const event of agent.stream({
    messages: [{ role: "user", content: "hi" }],
  })) {
    events.push(event);
  }
  return events;
};

describe("装配层帽(createAgent readOnlyConcurrency)", () => {
  it("readOnlyConcurrency 2 + 一步 5 个只读工具 → 最大同时在飞 ≤ 2,结果无丢失", async () => {
    const metrics = { active: 0, max: 0 };
    const agent = createAgent({
      model: multiToolCallModel(["r0", "r1", "r2", "r3", "r4"]),
      tools: [0, 1, 2, 3, 4].map((i) =>
        probeTool(`r${i}`, { readOnly: true, metrics }),
      ),
      readOnlyConcurrency: 2,
    });

    const events = await collectEvents(agent);

    expect(metrics.max).toBeLessThanOrEqual(2);
    expect(metrics.max).toBeGreaterThanOrEqual(2); // 帽真的在放行,不是串行
    const toolResults = events.filter(
      (e) => e.type === "tool-result",
    ) as Array<{
      output: string;
    }>;
    expect(toolResults).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(toolResults.some((r) => r.output === `r${i}-${i}`)).toBe(true);
    }
    const finishes = events.filter((e) => e.type === "finish");
    expect(finishes).toHaveLength(1);
  });

  it("混 2 只读 + 2 写 → 写工具立即开始,不等只读的帽", async () => {
    // 观测:写工具 enter 时打时间戳。只读工具 resolve 挂 100ms,写挂 5ms ——
    // 写若被帽挡到只读之后,enter 必然 > 100ms;直通则与只读同时(< 50ms)。
    const metrics = { active: 0, max: 0 };
    const startedAt = Date.now();
    let writeEnterAt: number | undefined;

    const readOnly = [0, 1].map((i) =>
      buildTool({
        name: `ro${i}`,
        description: `read probe ${i}`,
        inputSchema: z.object({ n: z.number().optional() }),
        readOnly: true,
        execute: async (input: { n?: number }) => {
          metrics.active += 1;
          metrics.max = Math.max(metrics.max, metrics.active);
          await new Promise((r) => setTimeout(r, 100));
          metrics.active -= 1;
          return `ro${i}-${input.n ?? "?"}`;
        },
      }),
    );
    const writeTool = buildTool({
      name: "w0",
      description: "write probe",
      inputSchema: z.object({ n: z.number().optional() }),
      execute: async (input: { n?: number }) => {
        writeEnterAt = Date.now() - startedAt;
        await new Promise((r) => setTimeout(r, 5));
        return `w0-${input.n ?? "?"}`;
      },
    });

    const agent = createAgent({
      model: multiToolCallModel(["ro0", "ro1", "w0"]),
      tools: [...readOnly, writeTool],
      readOnlyConcurrency: 2,
    });

    const events = await collectEvents(agent);

    const toolResults = events.filter(
      (e) => e.type === "tool-result",
    ) as Array<{
      output: string;
    }>;
    expect(toolResults).toHaveLength(3);
    expect(toolResults.some((r) => r.output === "w0-2")).toBe(true);
    // 写工具与只读同批启动(帽只拦只读)。上限放宽到只读时长的一半以下,
    // 排除调度噪声,但远小于"等只读退完"的 100ms。
    expect(writeEnterAt).toBeDefined();
    expect(writeEnterAt!).toBeLessThan(50);
    // 只读侧的帽语义仍成立。
    expect(metrics.max).toBeLessThanOrEqual(2);
  });

  it("不传 readOnlyConcurrency → 默认帽 10:10 个只读工具全部同时在飞", async () => {
    const metrics = { active: 0, max: 0 };
    const agent = createAgent({
      model: multiToolCallModel(Array.from({ length: 10 }, (_, i) => `d${i}`)),
      tools: Array.from({ length: 10 }, (_, i) =>
        probeTool(`d${i}`, { readOnly: true, metrics }),
      ),
    });

    await collectEvents(agent);

    // 默认 10:10 个并发 acquire 全部直通,不排队。
    expect(metrics.max).toBe(10);
  });

  it("web_fetch 已补 readOnly 标志", () => {
    const tool = createWebFetchTool({
      summaryModel: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({ chunks: [] }),
        }),
      }) as never,
    });
    expect(tool.readOnly).toBe(true);
  });
});
