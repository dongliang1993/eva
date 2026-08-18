import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UiMessageBuilder,
  createUserUIMessage,
  isDynamicToolPart,
  isTextPart,
  parseUIMessage,
  uiMessageSearchText,
  uiMessageText
} from "../packages/shared/src/index.js";
import type { EvaUIMessage, RunAgentStreamEvent } from "../packages/shared/src/index.js";
import { closeDb, initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";

const pushAll = (builder: UiMessageBuilder, events: RunAgentStreamEvent[]): void => {
  for (const event of events) {
    builder.push(event);
  }
};

describe("UiMessageBuilder", () => {
  it("按流事件顺序生成 parts:text → tool → text,两段 text 不被粘成一段", () => {
    const builder = new UiMessageBuilder("m1");
    pushAll(builder, [
      { type: "step-start", step: 0 },
      { type: "text-delta", textDelta: "好的" },
      { type: "tool-call", toolCallId: "tc-1", toolName: "read_file", input: { path: "a.ts" } },
      { type: "tool-result", toolCallId: "tc-1", toolName: "read_file", output: "x = 1", status: "success", durationMs: 5 },
      { type: "text-delta", textDelta: "完成" }
    ]);

    const msg = builder.build();
    const types = msg.parts.map((p) => p.type);
    expect(types).toEqual(["step-start", "text", "dynamic-tool", "text"]);
    const texts = msg.parts.filter(isTextPart).map((p) => p.text);
    expect(texts).toEqual(["好的", "完成"]);
  });

  it("tool-result 回填到同一个 part 而不是新增", () => {
    const builder = new UiMessageBuilder("m1");
    pushAll(builder, [
      { type: "tool-call", toolCallId: "tc-1", toolName: "read_file", input: { path: "a.ts" } },
      { type: "tool-result", toolCallId: "tc-1", toolName: "read_file", output: "x = 1", status: "success", durationMs: 5 }
    ]);

    const msg = builder.build();
    expect(msg.parts).toHaveLength(1);
    const tool = msg.parts[0]!;
    expect(isDynamicToolPart(tool)).toBe(true);
    if (isDynamicToolPart(tool)) {
      expect(tool.state).toBe("output-available");
      expect(tool.output).toBe("x = 1");
      expect(tool.toolMetadata?.durationMs).toBe(5);
    }
  });

  it("tool 执行失败落成 output-error + errorText", () => {
    const builder = new UiMessageBuilder("m1");
    pushAll(builder, [
      { type: "tool-call", toolCallId: "tc-1", toolName: "write_file", input: { path: "a.ts" } },
      { type: "tool-result", toolCallId: "tc-1", toolName: "write_file", output: "boom", status: "error", durationMs: 2 }
    ]);

    const msg = builder.build();
    const tool = msg.parts[0]!;
    expect(isDynamicToolPart(tool)).toBe(true);
    if (isDynamicToolPart(tool)) {
      expect(tool.state).toBe("output-error");
      expect(tool.errorText).toBe("boom");
    }
  });

  it("build() 把 streaming 的 text part 收成 done", () => {
    const builder = new UiMessageBuilder("m1");
    builder.push({ type: "text-delta", textDelta: "hello" });

    const streaming = builder.snapshot();
    const streamingText = streaming.parts.find(isTextPart);
    expect(streamingText?.state).toBe("streaming");

    const built = builder.build();
    const builtText = built.parts.find(isTextPart);
    expect(builtText?.state).toBe("done");
    expect(builtText?.text).toBe("hello");
  });

  it("thinkingDurationMs = 首个 text-delta 与 startedAt 的差", () => {
    vi.useFakeTimers();
    const start = 1000;
    vi.setSystemTime(start);
    const builder = new UiMessageBuilder("m1", start);

    vi.setSystemTime(start + 250);
    builder.push({ type: "text-delta", textDelta: "hi" });

    vi.setSystemTime(start + 500);
    const msg = builder.build();

    expect(msg.metadata?.thinkingDurationMs).toBe(250);
    vi.useRealTimers();
  });

  it("finish 事件的 usage 进 metadata", () => {
    const builder = new UiMessageBuilder("m1");
    pushAll(builder, [
      { type: "text-delta", textDelta: "hi" },
      {
        type: "finish",
        text: "hi",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        durationMs: 100
      }
    ]);

    expect(builder.build().metadata?.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15
    });
  });

  it("未知的 toolCallId 的 tool-result 被忽略", () => {
    const builder = new UiMessageBuilder("m1");
    builder.push({ type: "tool-call", toolCallId: "tc-1", toolName: "read_file", input: {} });
    builder.push({
      type: "tool-result",
      toolCallId: "tc-orphan",
      toolName: "read_file",
      output: "x",
      status: "success"
    });

    expect(builder.build().parts).toHaveLength(1);
  });
});

describe("uiMessageSearchText", () => {
  it("包含正文与 ≤1000 字符的成功工具输出", () => {
    const msg: EvaUIMessage = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "text", text: "hello", state: "done" },
        {
          type: "dynamic-tool",
          toolName: "read_file",
          toolCallId: "tc-1",
          state: "output-available",
          input: {},
          output: "file contents"
        }
      ]
    };

    expect(uiMessageSearchText(msg)).toBe("hello file contents");
  });

  it("排除超长工具输出与失败工具输出", () => {
    const long = "x".repeat(1001);
    const msg: EvaUIMessage = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "text", text: "body", state: "done" },
        {
          type: "dynamic-tool",
          toolName: "read_file",
          toolCallId: "tc-long",
          state: "output-available",
          input: {},
          output: long
        },
        {
          type: "dynamic-tool",
          toolName: "write_file",
          toolCallId: "tc-err",
          state: "output-error",
          input: {},
          errorText: "boom"
        }
      ]
    };

    expect(uiMessageSearchText(msg)).toBe("body");
  });
});

describe("parseUIMessage", () => {
  it("非 JSON 降级成单 text part", () => {
    const msg = parseUIMessage("just plain text", { id: "m1", role: "user" });
    expect(msg.parts).toHaveLength(1);
    expect(uiMessageText(msg)).toBe("just plain text");
  });

  it("内容恰好是 JSON 数组的用户消息不会被误解析(旧 serializeMessageContent 歧义回归)", () => {
    const raw = JSON.stringify(createUserUIMessage("m1", '[{"type":"text","text":"x"}]'));
    const parsed = parseUIMessage(raw, { id: "m1", role: "user" });
    expect(uiMessageText(parsed)).toBe('[{"type":"text","text":"x"}]');
  });

  it("形状不对(无 parts)降级", () => {
    const parsed = parseUIMessage(JSON.stringify({ foo: "bar" }), { id: "m1", role: "assistant" });
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0]).toMatchObject({ type: "text" });
  });
});

describe("0014 迁移", () => {
  let db: AppDatabase;
  const rawClient = (): import("better-sqlite3").Database =>
    (db as unknown as { $client: import("better-sqlite3").Database }).$client;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
  });

  afterEach(() => {
    closeDb(db);
  });

  it("json_object 嵌套不会被字符串转义", () => {
    const sqlite = rawClient();
    const row = sqlite
      .prepare("SELECT json_object('parts', json_array(json_object('type','text'))) AS v")
      .get() as { v: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.v).parts[0].type).toBe("text");
  });

  it("迁移后 messages 表有 message 列、没有 content/token_usage 列", () => {
    migrateDb(db);
    const sqlite = rawClient();
    const cols = (sqlite.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>)
      .map((c) => c.name);

    expect(cols).toContain("message");
    expect(cols).toContain("run_id");
    expect(cols).toContain("parent_id");
    expect(cols).toContain("slot_id");
    expect(cols).toContain("depth");
    expect(cols).not.toContain("content");
    expect(cols).not.toContain("metadata");
    expect(cols).not.toContain("token_usage");
  });

  it("迁移后 runs 表存在且有终态列", () => {
    migrateDb(db);
    const sqlite = rawClient();
    const cols = (sqlite.prepare("PRAGMA table_info('runs')").all() as Array<{ name: string }>)
      .map((c) => c.name);

    expect(cols).toContain("status");
    expect(cols).toContain("finish_reason");
    expect(cols).toContain("usage");
    expect(cols).toContain("started_at");
    expect(cols).toContain("ended_at");
  });
});