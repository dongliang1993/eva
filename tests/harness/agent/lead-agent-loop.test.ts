import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { createAgent } from "../../../packages/harness/src/agents/agent.js";
import type { AgentTelemetryEvent } from "../../../packages/harness/src/agents/observer.js";
import type { AgentStreamEvent } from "../../../packages/harness/src/agents/types.js";
import { buildTool } from "../../../packages/harness/src/tools/build-tool.js";

type FinishEvent = Extract<AgentStreamEvent, { type: "finish" }>;

const isFinish = (event: AgentStreamEvent): event is FinishEvent =>
  event.type === "finish";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/**
 * 造一个多步 mock 模型:第一步产 tool-call,第二步产纯文本。
 */
const toolThenTextModel = (): MockLanguageModelV4 => {
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
              { type: "tool-input-start", id: "tc-1", toolName: "echo" },
              {
                type: "tool-call",
                toolCallId: "tc-1",
                toolName: "echo",
                input: JSON.stringify({ msg: "line1\nline2" }),
              },
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

const echoTool = () =>
  buildTool({
    name: "echo",
    description: "echo the msg",
    inputSchema: z.object({ msg: z.string() }),
    execute: async (input: { msg: string }) => input.msg,
  });

const failingTool = () =>
  buildTool({
    name: "fail",
    description: "always throws",
    inputSchema: z.object({}),
    execute: async () => {
      throw new Error("kaboom");
    },
  });

const collect = async (
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

describe("工具循环", () => {
  it("【回归】工具输出原样透出,没有 JSON 二次转义", async () => {
    const agent = createAgent({
      model: toolThenTextModel(),
      tools: [echoTool()],
    });

    const events = await collect(agent);
    const toolResults = events.filter((e) => e.type === "tool-result");
    expect(toolResults.length).toBeGreaterThan(0);
    // 重构前会是 "\"line1\\nline2\"" —— 二次 JSON 转义
    expect((toolResults[0] as { output: string }).output).toBe("line1\nline2");
  });

  it("工具抛异常 → status 'error',output 以 Error: 开头", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id: "tc-1", toolName: "fail" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "fail",
              input: JSON.stringify({}),
            },
            { type: "finish", finishReason: "tool-calls", usage },
          ],
        }),
      }),
    });
    const agent = createAgent({ model, tools: [failingTool()] });

    const events = await collect(agent);
    const toolResults = events.filter((e) => e.type === "tool-result");
    expect(toolResults.length).toBeGreaterThan(0);
    const tr = toolResults[0] as { output: string; status: string };
    expect(tr.status).toBe("error");
    expect(tr.output.startsWith("Error:")).toBe(true);
    expect(tr.output).toContain("kaboom");
  });

  it("两个 step:调工具 → 拿结果 → 输出文本(SDK 驱动 loop,无需手写 for-step)", async () => {
    const agent = createAgent({
      model: toolThenTextModel(),
      tools: [echoTool()],
    });

    const events = await collect(agent);

    // 两个 step:step-start 出现 2 次,step 分别是 0 和 1
    const stepStarts = events.filter((e) => e.type === "step-start") as Array<{
      step: number;
    }>;
    expect(stepStarts).toHaveLength(2);
    expect(stepStarts[0]!.step).toBe(0);
    expect(stepStarts[1]!.step).toBe(1);

    const finishes = events.filter(isFinish);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.finishReason).toBe("stop");
    expect(finishes[0]!.text).toBe("done");
  });

  it("达到 maxSteps → finish(max-steps) + 文案带实际步数与继续路径 + observer 留痕", async () => {
    const calls = { count: 0 };
    // 每一步都产 tool-call,永不输出文本 → 触顶
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls.count += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-input-start",
                id: `tc-${calls.count}`,
                toolName: "echo",
              },
              {
                type: "tool-call",
                toolCallId: `tc-${calls.count}`,
                toolName: "echo",
                input: JSON.stringify({ msg: "x" }),
              },
              { type: "finish", finishReason: "tool-calls", usage },
            ],
          }),
        };
      },
    });
    const telemetry: AgentTelemetryEvent[] = [];
    const agent = createAgent({
      model,
      tools: [echoTool()],
      maxSteps: 2,
      observer: (event) => telemetry.push(event),
    });

    const events = await collect(agent);
    const finishes = events.filter(isFinish);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.finishReason).toBe("max-steps");
    // 文案必须带实际步数(2,不是硬编码 100)与"怎么续"的路径
    expect(finishes[0]!.text).toContain("(2)");
    expect(finishes[0]!.text).toContain("continue");
    // 撞顶是异常,异常必须在事件流留痕(将来排查"agent 为什么停了"不靠问用户)
    const transitions = telemetry.filter((e) => e.type === "loop_transition");
    expect(transitions.some((e) => e.reason === "max_steps")).toBe(true);
  });

  it("模型只产 tool-call 从不说话 → finish 文本是空响应兜底", async () => {
    const calls = { count: 0 };
    // 第一步 tool-call,第二步空(无文本无 tool)→ 累计文本为空
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls.count += 1;
        if (calls.count === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "tc-1",
                  toolName: "echo",
                  input: JSON.stringify({ msg: "x" }),
                },
                { type: "finish", finishReason: "tool-calls", usage },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "finish", finishReason: "stop", usage },
            ],
          }),
        };
      },
    });
    const agent = createAgent({ model, tools: [echoTool()] });

    const events = await collect(agent);
    const finishes = events.filter(isFinish);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.finishReason).toBe("stop");
    expect(finishes[0]!.text).toBe("The model returned an empty response.");
  });
});

describe("max-output 续写", () => {
  // 注意:MockLanguageModelV4 的 finish chunk 把 finishReason 字符串统一成 'other',
  // 无法在 mock 下端到端触发 finishReason==='length' 的续写路径。这里只单测判定逻辑
  // 与续写消息常量;真实 provider 的端到端续写由手工验收覆盖(T2 §5)。
  it("shouldContinueForMaxOutput: length + 未超限 → 续写;超限或非 length → 不续写", async () => {
    const { shouldContinueForMaxOutput, MAX_OUTPUT_CONTINUATION_MESSAGE } =
      await import("../../../packages/harness/src/agents/context-strategy.js");
    const policy = {
      contextWindow: 128_000,
      reservedOutputTokens: 8_000,
      loopCompactBufferTokens: 12_000,
      blockingBufferTokens: 4_000,
      toolResultBudgetTokens: 12_000,
      maxOutputRecoveryLimit: 3,
    };

    expect(shouldContinueForMaxOutput("length", 0, policy)).toBe(true);
    expect(shouldContinueForMaxOutput("length", 3, policy)).toBe(false);
    expect(shouldContinueForMaxOutput("stop", 0, policy)).toBe(false);

    // 续写指令是固定文案(不改,避免模型道歉/重复)
    expect(MAX_OUTPUT_CONTINUATION_MESSAGE).toContain("Continue directly");
    expect(MAX_OUTPUT_CONTINUATION_MESSAGE).toContain("Do not repeat");
  });
});

describe("abort", () => {
  it("流式中途 abort → 只有 finish(aborted),没有 error 事件", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "Hello" },
            { type: "text-delta", id: "1", delta: " world" },
            { type: "text-delta", id: "1", delta: " again" },
            { type: "text-end", id: "1" },
            { type: "finish", finishReason: "stop", usage },
          ],
          chunkDelayInMs: 60,
        }),
      }),
    });
    const agent = createAgent({ model });
    const events: AgentStreamEvent[] = [];

    for await (const event of agent.stream({
      messages: [{ role: "user", content: "hi" }],
      abortSignal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "text-delta" && !controller.signal.aborted) {
        controller.abort();
      }
    }

    const finishes = events.filter(isFinish);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.finishReason).toBe("aborted");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("abort 在飞工具收口(T26)", () => {
  const usage2 = usage;

  /** 第一步发 count 个 tool-call 后挂住工具;第二步本不该到达。 */
  const twoCallModel = (): MockLanguageModelV4 =>
    new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id: "tc-1", toolName: "hung" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "hung",
              input: JSON.stringify({}),
            },
            { type: "tool-input-start", id: "tc-2", toolName: "hung" },
            {
              type: "tool-call",
              toolCallId: "tc-2",
              toolName: "hung",
              input: JSON.stringify({}),
            },
            { type: "finish", finishReason: "tool-calls", usage: usage2 },
          ],
        }),
      }),
    });

  const neverTool = () =>
    buildTool({
      name: "hung",
      description: "never resolves",
      inputSchema: z.object({}),
      execute: () => new Promise<string>(() => {}),
    });

  const collectUntilFinish = (
    agent: ReturnType<typeof createAgent>,
    controller: AbortController,
    abortWhen: (event: AgentStreamEvent) => boolean,
  ): Promise<AgentStreamEvent[]> =>
    (async () => {
      const events: AgentStreamEvent[] = [];
      for await (const event of agent.stream({
        messages: [{ role: "user", content: "hi" }],
        abortSignal: controller.signal,
      })) {
        events.push(event);
        if (abortWhen(event) && !controller.signal.aborted) {
          controller.abort();
        }
      }
      return events;
    })();

  it("工具在飞时 abort → finish 前补发取消 tool-result,finish 汇总带它", async () => {
    const controller = new AbortController();
    const agent = createAgent({ model: twoCallModel(), tools: [neverTool()] });

    const events = await collectUntilFinish(agent, controller, (e) => {
      // 两个 tool-call 都发起后 abort;工具永不 resolve,SDK 丢弃在飞结果。
      if (e.type === "tool-call" && e.toolCallId === "tc-2") {
        // 让 SDK 把 tool-call 消费完、进入工具执行阶段后再断。
        return true;
      }
      return false;
    });

    const finishes = events.filter(isFinish);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.finishReason).toBe("aborted");

    const finishIndex = events.findIndex((e) => e.type === "finish");
    const canceled = events.filter(
      (e, i) =>
        e.type === "tool-result" && e.status === "error" && i < finishIndex,
    );
    expect(canceled.map((e) => (e as { toolCallId: string }).toolCallId)).toEqual([
      "tc-1",
      "tc-2",
    ]);
    for (const e of canceled) {
      expect(
        (e as { output: string }).output.startsWith("Error:"),
      ).toBe(true);
    }

    const summary = finishes[0]!.toolCalls;
    expect(summary.map((t) => t.toolCallId)).toEqual(["tc-1", "tc-2"]);
    expect(summary.every((t) => t.status === "error")).toBe(true);
  });

  it("无在飞工具时 abort(纯文本)→ 不补发任何 tool-result", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "Hello" },
            { type: "text-delta", id: "1", delta: " world" },
            { type: "text-end", id: "1" },
            { type: "finish", finishReason: "stop", usage: usage2 },
          ],
          chunkDelayInMs: 60,
        }),
      }),
    });
    const agent = createAgent({ model });

    const events = await collectUntilFinish(
      agent,
      controller,
      (e) => e.type === "text-delta",
    );

    expect(events.some((e) => e.type === "tool-result")).toBe(false);
    const finishes = events.filter(isFinish);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.finishReason).toBe("aborted");
    expect(finishes[0]!.toolCalls).toEqual([]);
  });

  it("单个在飞工具 abort → 补发落在 finish 之前(移除实验锚点)", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id: "tc-1", toolName: "hung" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "hung",
              input: JSON.stringify({}),
            },
            { type: "finish", finishReason: "tool-calls", usage },
          ],
        }),
      }),
    });
    const agent = createAgent({ model, tools: [neverTool()] });

    const events = await collectUntilFinish(
      agent,
      controller,
      (e) => e.type === "tool-call",
    );

    const kinds = events.map((e) => e.type);
    const resultIndex = kinds.indexOf("tool-result");
    const finishIndex = kinds.indexOf("finish");
    // 补发的取消 result 必须先于 finish(SSE 在 finish 后收尾,之后的事件客户端收不到)。
    expect(resultIndex).toBeGreaterThan(-1);
    expect(finishIndex).toBeGreaterThan(resultIndex);
  });
});
describe("工具超时(T25 toolTimeout 配置)", () => {
  const hungThenTextModel = (): MockLanguageModelV4 => {
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
                { type: "tool-input-start", id: "tc-1", toolName: "hung" },
                {
                  type: "tool-call",
                  toolCallId: "tc-1",
                  toolName: "hung",
                  input: JSON.stringify({}),
                },
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
              { type: "text-delta", id: "1", delta: "survived" },
              { type: "text-end", id: "1" },
              { type: "finish", finishReason: "stop", usage },
            ],
          }),
        };
      },
    });
  };
  const hungTool = () =>
    buildTool({
      name: "hung",
      description: "never resolves",
      inputSchema: z.object({}),
      // 不检查 abortSignal 的工具:模拟 fs 挂死(NFS/磁盘满)——
      // toolMs 到点后 SDK 折成的 AbortSignal 没人看,靠 build-tool 的
      // race 兜底才能收口。
      execute: () => new Promise<string>(() => {}),
    });

  it("toolMs 到点 → 挂死工具以 Error: 收口,循环继续到 finish", async () => {
    const startedAt = Date.now();
    const agent = createAgent({
      model: hungThenTextModel(),
      tools: [hungTool()],
      toolTimeout: { toolMs: 100 },
    });

    const events = await collect(agent);
    const elapsed = Date.now() - startedAt;

    const toolResults = events.filter(
      (e) => e.type === "tool-result",
    ) as Array<{ output: string; status: string }>;
    expect(toolResults.length).toBeGreaterThan(0);
    expect(toolResults[0]!.output.startsWith("Error:")).toBe(true);
    // 循环没死:模型收到错误文本后正常收尾
    const finishes = events.filter(isFinish);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.finishReason).toBe("stop");
    expect(finishes[0]!.text).toBe("survived");
    // 挂死工具被 100ms 超时收口,而不是把整个 run 挂住
    expect(elapsed).toBeLessThan(5_000);
  });

  it("不配 toolTimeout → 现状语义:挂死工具挂死 run(回归边界)", async () => {
    const agent = createAgent({
      model: hungThenTextModel(),
      tools: [hungTool()],
    });

    // 断言"不配超时就没有隐形兜底"(T25 坑 6:harness 不默认开启):
    // 消费 500ms,一个 finish/tool-result 都不该出现。
    const events: AgentStreamEvent[] = [];
    await Promise.race([
      (async () => {
        for await (const event of agent.stream({
          messages: [{ role: "user", content: "hi" }],
        })) {
          events.push(event);
        }
      })(),
      new Promise((r) => setTimeout(r, 500)),
    ]);
    expect(
      events.some((e) => e.type === "finish" || e.type === "tool-result"),
    ).toBe(false);
  });
});
