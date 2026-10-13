import { toRunStreamFrames } from "../../helpers/frames.js";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import { query, textResult, tool } from "../../../packages/harness/src/index.js";
import { replayEventsFor } from "../../../packages/shared/src/replay-events.js";
import { toolPartToInfo } from "../../../apps/web/src/shared/api/run-stream-client.js";
import type { EvaDynamicToolPart } from "../../../packages/shared/src/ui-message.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

const textChunks = (text: string) => [
  { type: "stream-start" as const, warnings: [] as never[] },
  { type: "text-start" as const, id: "1" },
  { type: "text-delta" as const, id: "1", delta: text },
  { type: "text-end" as const, id: "1" },
  { type: "finish" as const, finishReason: "stop" as const, usage }
];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("T51 durationMs 迁移", () => {
  it("abort 补发:帧形状不变(拉出 running 态),tool_timing 标 abandoned 不伪造三段", async () => {
    const slowTool = tool({
      name: "slow",
      description: "t",
      inputSchema: z.object({}),
      execute: async () => {
        await sleep(2_000);
        return textResult("late");
      }
    });

    let callIndex = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callIndex += 1;
        if (callIndex === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-input-start", id: "tc-1", toolName: "slow" },
                { type: "tool-call", toolCallId: "tc-1", toolName: "slow", input: "{}" },
                { type: "finish", finishReason: "tool-calls", usage }
              ]
            })
          };
        }
        return { stream: simulateReadableStream({ chunks: textChunks("unreachable") }) };
      }
    });

    const controller = new AbortController();
    const events: ReturnType<typeof toRunStreamFrames> extends readonly (infer T)[] ? T[] : never[] = [];
    const timingMessages: {
      toolTiming: Record<string, { approval_wait_ms: number; queue_wait_ms: number; exec_ms: number; aborted: boolean }>;
    }[] = [];
    const run = query({
      prompt: [{ role: "user", content: "hi" }],
      options: {
        model: { languageModel: model, id: "mock:model" },
        tools: [slowTool],
        maxTurns: 5,
        abortController: controller
      }
    });

    for await (const message of run) {
      if (message.type === "user") {
        timingMessages.push({ toolTiming: message.tool_timing });
      }
      for (const event of toRunStreamFrames(message)) {
        events.push(event);
        if (event.type === "tool-call") {
          controller.abort();
        }
      }
    }

    // 卡片被拉出 running 态:有一条 tool-result 帧(形状与迁移前一致)。
    const result = events.find(
      (e) => e.type === "tool-result" && e.toolCallId === "tc-1"
    );
    expect(result).toBeDefined();
    if (result?.type !== "tool-result") throw new Error("unreachable");
    expect(result.status).toBe("error");
    expect(result.output).toContain("tool call aborted");
    // 补发帧的兼容形状:durationMs = 未分解墙钟(三段之和;此时工具没真跑,和为 0)。
    // 三段字段随之带 0(「没等、没跑」的 0 语义,tool-timing.test 的 plan gate 同款) ——
    // T3 起 tool_timing 是 user 消息的字段,补发不再有独立的「只带 durationMs」形态。
    expect(result.durationMs).toBe(0);
    expect(result.toolExecMs).toBe(0);
    expect(result.approvalWaitMs).toBe(0);
    expect(result.queueWaitMs).toBe(0);

    // observer 的 tool_call_abandoned 已删:同一信息由 user 消息的
    // tool_timing[tc-1].aborted 表达;attempt 计数已随 observer 删;同一信息无消息流替代。
    const timing = timingMessages
      .map((m) => m.toolTiming["tc-1"])
      .find((t) => t !== undefined);
    expect(timing).toBeDefined();
    expect(timing?.aborted).toBe(true);
    expect(timing?.toolExecMs).toBeUndefined();
    expect(timing?.approvalWaitMs).toBeUndefined();
    expect(timing?.queueWaitMs).toBeUndefined();
  });

  it("toolPartToInfo:新三段字段映射;旧 toolMetadata.durationMs 不回灌", () => {
    const legacyPart: EvaDynamicToolPart = {
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "tc-old",
      state: "output-available",
      input: { command: "ls" },
      output: "ok",
      toolMetadata: { durationMs: 403_000 }
    };
    const legacy = toolPartToInfo(legacyPart);
    expect(legacy.toolExecMs).toBeUndefined(); // 旧消息隐藏徽章的判据:没有新字段
    expect(legacy.approvalWaitMs).toBeUndefined();
    expect(legacy.queueWaitMs).toBeUndefined();

    const freshPart: EvaDynamicToolPart = {
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "tc-new",
      state: "output-available",
      input: { command: "ls" },
      output: "ok",
      toolMetadata: { toolExecMs: 51, approvalWaitMs: 402_926, queueWaitMs: 3 }
    };
    const fresh = toolPartToInfo(freshPart);
    expect(fresh.toolExecMs).toBe(51);
    expect(fresh.approvalWaitMs).toBe(402_926);
    expect(fresh.queueWaitMs).toBe(3);
  });

  it("replay-events:新字段随重放回灌,旧 durationMs 不回灌", () => {
    const message = {
      id: "m1",
      role: "assistant" as const,
      parts: [
        {
          type: "dynamic-tool" as const,
          toolName: "bash",
          toolCallId: "tc-1",
          state: "output-available" as const,
          input: { command: "ls" },
          output: "ok",
          toolMetadata: { toolExecMs: 51, approvalWaitMs: 2_000, durationMs: 999_999 }
        }
      ]
    };

    const events = replayEventsFor(message as never);
    const result = events.find((e) => e.type === "tool-result");
    expect(result).toBeDefined();
    if (result?.type !== "tool-result") throw new Error("unreachable");
    expect(result.toolExecMs).toBe(51);
    expect(result.approvalWaitMs).toBe(2_000);
    expect(result.durationMs).toBeUndefined();
  });

  it("toolMetadata.durationMs 在 apps/packages 源码里零命中(隐藏旧徽章不再靠读它)", () => {
    const offenders: string[] = [];
    const roots = ["apps", "packages"];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const content = readFileSync(full, "utf8");
          if (content.includes("toolMetadata.durationMs") || content.includes("toolMetadata?.durationMs")) {
            offenders.push(full);
          }
        }
      }
    };
    for (const root of roots) {
      walk(path.join(process.cwd(), root));
    }
    expect(offenders).toEqual([]);
  });
});
