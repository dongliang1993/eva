import { describe, expect, it } from "vitest";
import type { TextStreamPart, ToolSet } from "ai";

import { finishTurn, runTurn } from "../../../packages/harness/src/query/turn.js";
import type { HarnessMessage } from "../../../packages/harness/src/query/types.js";

const part = (p: TextStreamPart<ToolSet>): TextStreamPart<ToolSet> => p;

const streamOf = (parts: readonly TextStreamPart<ToolSet>[]): AsyncIterable<TextStreamPart<ToolSet>> =>
  (async function* () {
    for (const p of parts) yield p;
  })();

const base = {
  turn: 0,
  parentToolUseID: null,
  turnStartedAt: Date.now(),
} as const;

describe("runTurn 顺序保证", () => {
  it("step_start 恒发且先于一切;text 块在 text-end 时一条 assistant", async () => {
    const output = await runTurn({
      ...base,
      includePartialMessages: true,
      stream: streamOf([
        part({ type: "text-start", id: "t1" }),
        part({ type: "text-delta", id: "t1", text: "hel" }),
        part({ type: "text-delta", id: "t1", text: "lo" }),
        part({ type: "text-end", id: "t1" }),
      ]),
    });

    const kinds = output.messages.map((m) =>
      m.type === "stream_event" ? `stream_event:${m.event.type}` : m.type,
    );
    expect(kinds).toEqual([
      "stream_event:step_start",
      "stream_event:text_delta",
      "stream_event:text_delta",
      "assistant",
    ]);
    const assistant = output.messages[3];
    if (assistant?.type !== "assistant") throw new Error("unreachable");
    expect(assistant.message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(assistant.turn).toBe(0);
  });

  it("includePartialMessages=false:text 的 assistant 是唯一文本来源", async () => {
    const output = await runTurn({
      ...base,
      includePartialMessages: false,
      stream: streamOf([
        part({ type: "text-start", id: "t1" }),
        part({ type: "text-delta", id: "t1", text: "quiet" }),
        part({ type: "text-end", id: "t1" }),
      ]),
    });

    expect(output.messages.filter((m) => m.type === "stream_event").length).toBe(1);
    expect(output.messages[1]?.type).toBe("assistant");
  });

  it("tool-call 块到达即发 assistant(先于 tool-result);tool_result 收集到 TurnOutput", async () => {
    const output = await runTurn({
      ...base,
      includePartialMessages: true,
      stream: streamOf([
        part({ type: "tool-input-start", id: "tc-1", toolName: "echo" }),
        part({ type: "tool-input-delta", id: "tc-1", delta: "{\"msg\"" }),
        part({
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "echo",
          input: { msg: "hi" },
        }),
        part({
          type: "tool-result",
          toolCallId: "tc-1",
          toolName: "echo",
          input: { msg: "hi" },
          output: { type: "text", value: "out:hi" },
        } as never),
      ]),
    });

    const kinds = output.messages.map((m) =>
      m.type === "stream_event" ? `stream_event:${m.event.type}` : m.type,
    );
    expect(kinds).toEqual([
      "stream_event:step_start",
      "stream_event:tool_input_start",
      "stream_event:tool_input_delta",
      "assistant",
    ]);
    // tool-call 的 assistant content 带完整 input(审批帧/SSE tool-call 帧的来源)。
    const assistant = output.messages[3];
    if (assistant?.type !== "assistant") throw new Error("unreachable");
    expect(assistant.message.content).toEqual([
      { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { msg: "hi" } },
    ]);
    // tool-result 收集:outputText + isError(前缀判,与 errorResult 同一通道)。
    expect(output.toolResults).toEqual([
      { toolCallId: "tc-1", toolName: "echo", outputText: "out:hi", isError: false },
    ]);
    expect(output.ttftMs).not.toBeNull();
  });

  it("error 输出(text 带 Error: 前缀)→ isError=true", async () => {
    const output = await runTurn({
      ...base,
      includePartialMessages: true,
      stream: streamOf([
        part({
          type: "tool-result",
          toolCallId: "tc-1",
          toolName: "boom",
          input: {},
          output: { type: "text", value: "Error: kaput" },
        } as never),
      ]),
    });
    expect(output.toolResults[0]?.isError).toBe(true);
  });
});

describe("finishTurn 终局两条", () => {
  it("turn_complete + user(一条消息装全部结果,计时按 tool_use_id)", () => {
    const messages = finishTurn({
      turn: 0,
      parentToolUseID: null,
      ttftMs: 120,
      durationMs: 300,
      stopReason: "tool-calls",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
      toolResults: [
        { toolCallId: "tc-1", toolName: "echo", outputText: "a", isError: false },
        { toolCallId: "tc-2", toolName: "boom", outputText: "Error: x", isError: true },
      ],
      toolTiming: {
        "tc-1": { approval_wait_ms: 0, queue_wait_ms: 0, exec_ms: 12, aborted: false },
        "tc-2": { approval_wait_ms: 30, queue_wait_ms: 0, exec_ms: 8, aborted: false },
      },
    });

    expect(messages.map((m: HarnessMessage) => m.type)).toEqual(["system", "user"]);
    const user = messages[1];
    if (user?.type !== "user") throw new Error("unreachable");
    expect(user.tool_timing["tc-2"]?.approval_wait_ms).toBe(30);
    expect(user.message.content).toHaveLength(2);
  });

  it("无工具结果:只有 turn_complete,不发空 user", () => {
    const messages = finishTurn({
      turn: 1,
      parentToolUseID: null,
      ttftMs: null,
      durationMs: 50,
      stopReason: "stop",
      usage: { input_tokens: 1, output_tokens: 1 },
      toolResults: [],
      toolTiming: {},
    });
    expect(messages.map((m) => m.type)).toEqual(["system"]);
    const complete = messages[0];
    if (complete?.type !== "system") throw new Error("unreachable");
    expect(complete.subtype).toBe("turn_complete");
    expect(complete.ttft_ms).toBeNull();
  });
});
