import { describe, expect, it } from "vitest";

import { UiMessageBuilder, replayEventsFor } from "../../packages/shared/src/index.js";
import type { EvaUIMessage, RunAgentStreamEvent } from "../../packages/shared/src/index.js";

const fold = (events: readonly RunAgentStreamEvent[]): EvaUIMessage => {
  const builder = new UiMessageBuilder("replayed");
  for (const event of events) {
    builder.push(event);
  }
  return builder.snapshot();
};

/** state 归一:重放出来的 text/reasoning 回到 streaming,build() 时才收成 done。 */
const normalize = (message: EvaUIMessage): unknown =>
  message.parts.map((part) =>
    part.type === "text" || part.type === "reasoning"
      ? { ...part, state: "streaming" }
      : part
  );

const streamed = (events: readonly RunAgentStreamEvent[]): EvaUIMessage => {
  const builder = new UiMessageBuilder("original");
  for (const event of events) {
    builder.push(event);
  }
  return builder.snapshot();
};

/**
 * 这组测试是重连正确性的地基:replayEventsFor 必须是 UiMessageBuilder.push 的逆运算。
 * 任何一方改了事件 → part 的映射,这里就该红。
 */
describe("replayEventsFor", () => {
  const roundTrip = (name: string, events: readonly RunAgentStreamEvent[]): void => {
    it(`round-trip:${name}`, () => {
      const original = streamed(events);
      const replayed = fold(replayEventsFor(original));

      expect(normalize(replayed)).toEqual(normalize(original));
    });
  };

  roundTrip("多 step + 工具成功 + 前后两段 text", [
    { type: "step-start", step: 0 },
    { type: "text-delta", textDelta: "我先看" },
    { type: "text-delta", textDelta: "一下文件" },
    { type: "tool-call", toolCallId: "tc-1", toolName: "read_file", input: { path: "a.ts" } },
    { type: "tool-result", toolCallId: "tc-1", toolName: "read_file", output: "x = 1", status: "success", durationMs: 7 },
    { type: "step-start", step: 1 },
    { type: "text-delta", textDelta: "看完了" }
  ]);

  roundTrip("工具失败(output-error + durationMs)", [
    { type: "tool-call", toolCallId: "tc-1", toolName: "bash", input: { cmd: "false" } },
    { type: "tool-result", toolCallId: "tc-1", toolName: "bash", output: "exit 1", status: "error", durationMs: 3 }
  ]);

  roundTrip("工具未结算(重连时正卡在工具里)", [
    { type: "text-delta", textDelta: "跑一下" },
    { type: "tool-call", toolCallId: "tc-1", toolName: "bash", input: { cmd: "sleep 60" } }
  ]);

  roundTrip("reasoning 与 text 交错", [
    { type: "reasoning-delta", textDelta: "先想想" },
    { type: "text-delta", textDelta: "答案是" },
    { type: "reasoning-delta", textDelta: "……再补一句" },
    { type: "text-delta", textDelta: "42" }
  ]);

  roundTrip("空消息(run 刚起,还没有任何 part)", []);

  it("不回放 finish —— usage 只属于真正的终态", () => {
    const original = streamed([
      { type: "text-delta", textDelta: "done" },
      { type: "finish", text: "done", toolCalls: [], finishReason: "stop", usage: { totalTokens: 9 } }
    ]);

    expect(original.metadata?.usage).toEqual({ totalTokens: 9 });
    expect(replayEventsFor(original).some((e) => e.type === "finish")).toBe(false);
    expect(fold(replayEventsFor(original)).metadata?.usage).toBeUndefined();
  });

  it("step-start 的分段语义被保留:工具/step 之后的正文不与之前粘连", () => {
    const original = streamed([
      { type: "text-delta", textDelta: "A" },
      { type: "step-start", step: 1 },
      { type: "text-delta", textDelta: "B" }
    ]);

    const replayed = fold(replayEventsFor(original));
    expect(replayed.parts.map((p) => p.type)).toEqual(["text", "step-start", "text"]);
    expect(replayed.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text))
      .toEqual(["A", "B"]);
  });
});
