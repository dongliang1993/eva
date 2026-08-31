import { describe, expect, it } from "vitest";

import {
  chatProjectionReducer,
  initialChatProjection,
  runStreamedAction,
  type ChatProjection
} from "../../../apps/web/src/features/threads/stream-reducer.js";
import { UiMessageBuilder } from "../../../packages/shared/src/index.js";
import type {
  EvaUIMessage,
  RunAgentStreamEvent,
  ThreadMessage
} from "../../../packages/shared/src/index.js";

// ---------------------------------------------------------------------------
// §11.5 事件序列测试:投影是纯函数,所以每条性质都能用一串固定事件喂出来。
// 这层测试是后面拆 hook 的判据 —— hook 怎么改,这里的断言都不许变。
// ---------------------------------------------------------------------------

/** run controller 的 onEvent 就是这两步:喂累积器 → 投影。 */
const applyRunEvent = (
  state: ChatProjection,
  builder: UiMessageBuilder,
  event: RunAgentStreamEvent
): ChatProjection => chatProjectionReducer(state, runStreamedAction(builder, event));

const userMessage = (id: string, text: string): EvaUIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text, state: "done" }]
});

const row = (message: EvaUIMessage, siblingIds: readonly string[] = [message.id]): ThreadMessage => ({
  id: message.id,
  role: message.role === "user" ? "user" : "assistant",
  message,
  runId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  siblingIds
});

/** 一轮典型的 run:推理 → 正文 → 工具 → 收尾正文。 */
const RUN_EVENTS: readonly RunAgentStreamEvent[] = [
  { type: "step-start", step: 0 },
  { type: "reasoning-delta", textDelta: "先看看目录" },
  { type: "text-delta", textDelta: "我来" },
  { type: "text-delta", textDelta: "读一下。" },
  { type: "tool-input-start", toolCallId: "c1", toolName: "read_file" },
  { type: "tool-input-delta", toolCallId: "c1", delta: '{"path"' },
  { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } },
  { type: "tool-result", toolCallId: "c1", toolName: "read_file", output: "ok", status: "success", toolExecMs: 12 },
  { type: "text-delta", textDelta: "读完了。" },
  { type: "finish", text: "我来读一下。读完了。", toolCalls: [], finishReason: "stop" }
];

/** 把一串事件喂进一个新累积器,返回过程中每一次投影。 */
const replay = (
  from: ChatProjection,
  assistantId: string,
  events: readonly RunAgentStreamEvent[]
): { readonly states: readonly ChatProjection[]; readonly builder: UiMessageBuilder } => {
  const builder = new UiMessageBuilder(assistantId);
  const states: ChatProjection[] = [];
  let state = from;

  for (const event of events) {
    state = applyRunEvent(state, builder, event);
    states.push(state);
  }

  return { states, builder };
};

const textOf = (message: EvaUIMessage | null): string =>
  (message?.parts ?? [])
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");

describe("chatProjectionReducer:会话切换与本地消息", () => {
  it("thread/opened 清空上一个会话的投影,只留 sessionId", () => {
    const dirty = chatProjectionReducer(
      chatProjectionReducer(initialChatProjection, { type: "message/appended", message: userMessage("u1", "hi") }),
      { type: "run/opening", assistantId: "a1" }
    );

    const opened = chatProjectionReducer(dirty, { type: "thread/opened", threadId: "t2" });

    expect(opened.sessionId).toBe("t2");
    expect(opened.committed).toEqual([]);
    expect(opened.streaming).toBeNull();
    expect(opened.isStreaming).toBe(false);
    expect(opened.runId).toBeNull();
  });

  it("thread/reset 回到初始投影(新会话没有 sessionId)", () => {
    const state = chatProjectionReducer(initialChatProjection, { type: "thread/opened", threadId: "t1" });

    expect(chatProjectionReducer(state, { type: "thread/reset" })).toEqual(initialChatProjection);
  });

  it("thread/loaded 用服务端行整体替换 committed 与 siblingIdsById", () => {
    const a = userMessage("u1", "hi");
    const b: EvaUIMessage = { id: "a1", role: "assistant", parts: [{ type: "text", text: "yo", state: "done" }] };

    const loaded = chatProjectionReducer(initialChatProjection, {
      type: "thread/loaded",
      rows: [row(a), row(b, ["a1", "a2"])]
    });

    expect(loaded.committed).toEqual([a, b]);
    expect(loaded.siblingIdsById).toEqual({ u1: ["u1"], a1: ["a1", "a2"] });
  });

  it("message/dropped 只摘掉指定 id(409 回滚 / regenerate 摘旧版本)", () => {
    const withTwo = chatProjectionReducer(
      chatProjectionReducer(initialChatProjection, { type: "message/appended", message: userMessage("u1", "one") }),
      { type: "message/appended", message: userMessage("u2", "two") }
    );

    const dropped = chatProjectionReducer(withTwo, { type: "message/dropped", messageId: "u1" });

    expect(dropped.committed.map((m) => m.id)).toEqual(["u2"]);
  });
});

describe("§11.5 streaming 与 committed 分离", () => {
  it("整轮流式期间 committed 的数组引用一次都不变", () => {
    const loaded = chatProjectionReducer(initialChatProjection, {
      type: "thread/loaded",
      rows: [row(userMessage("u1", "读一下 a.ts"))]
    });
    const opened = chatProjectionReducer(loaded, { type: "run/opening", assistantId: "a1" });

    const { states } = replay(opened, "a1", RUN_EVENTS);

    for (const state of states) {
      expect(state.committed).toBe(loaded.committed);
    }
    // 在飞消息每帧都是新引用 —— 只有它变,memo 住的历史列表才不重渲染。
    expect(states[0]?.streaming).not.toBe(states[1]?.streaming);
  });

  it("run/settled 才把最终消息并进 committed,并清掉在飞态", () => {
    const opened = chatProjectionReducer(initialChatProjection, { type: "run/opening", assistantId: "a1" });
    const { states, builder } = replay(opened, "a1", RUN_EVENTS);
    const last = states[states.length - 1] as ChatProjection;

    const settled = chatProjectionReducer(last, { type: "run/settled", message: builder.build() });

    expect(settled.committed.map((m) => m.id)).toEqual(["a1"]);
    expect(settled.streaming).toBeNull();
    expect(settled.isStreaming).toBe(false);
    expect(settled.runId).toBeNull();
    // build() 收口:流式期间的 text/reasoning 落成 done。
    expect(settled.committed[0]?.parts.some((p) => "state" in p && p.state === "streaming")).toBe(false);
  });

  it("run/settled 的 message 为 null 时不动 committed(没有累积器的轮次)", () => {
    const opened = chatProjectionReducer(
      chatProjectionReducer(initialChatProjection, { type: "message/appended", message: userMessage("u1", "hi") }),
      { type: "run/opening", assistantId: "a1" }
    );

    const settled = chatProjectionReducer(opened, { type: "run/settled", message: null });

    expect(settled.committed).toBe(opened.committed);
    expect(settled.streaming).toBeNull();
    expect(settled.isStreaming).toBe(false);
  });

  it("run/rejected(服务端 409)退回没有 run 的样子,不留半条消息", () => {
    const opened = chatProjectionReducer(initialChatProjection, { type: "run/opening", assistantId: "a1" });
    const streamed = applyRunEvent(opened, new UiMessageBuilder("a1"), { type: "text-delta", textDelta: "x" });

    const rejected = chatProjectionReducer(streamed, { type: "run/rejected" });

    expect(rejected.streaming).toBeNull();
    expect(rejected.isStreaming).toBe(false);
    expect(rejected.runId).toBeNull();
    expect(rejected.committed).toEqual([]);
  });
});

describe("§11.5 重放不重复", () => {
  it("同一串事件喂两个新累积器,投影逐字节一致", () => {
    const opened = chatProjectionReducer(initialChatProjection, { type: "run/opening", assistantId: "a1" });

    const first = replay(opened, "a1", RUN_EVENTS);
    const second = replay(opened, "a1", RUN_EVENTS);

    expect(textOf(second.states[second.states.length - 1]?.streaming ?? null))
      .toBe(textOf(first.states[first.states.length - 1]?.streaming ?? null));
    expect(second.states[second.states.length - 1]?.streaming?.parts)
      .toEqual(first.states[first.states.length - 1]?.streaming?.parts);
  });

  it("断线重挂后从头重放,正文只出现一份(不叠加上一次的在飞内容)", () => {
    const opened = chatProjectionReducer(initialChatProjection, { type: "run/opening", assistantId: "a1" });

    // 第一次连接:只收到前半段就断了。
    const partial = replay(opened, "a1", RUN_EVENTS.slice(0, 4));
    expect(textOf(partial.states[partial.states.length - 1]?.streaming ?? null)).toBe("我来读一下。");

    // 重挂:新累积器 + run/attaching 重置在飞气泡,再整段重放。
    const reattached = chatProjectionReducer(partial.states[partial.states.length - 1] as ChatProjection, {
      type: "run/attaching",
      runId: "r1",
      assistantId: "a1"
    });
    const resumed = replay(reattached, "a1", RUN_EVENTS);

    expect(textOf(resumed.states[resumed.states.length - 1]?.streaming ?? null)).toBe("我来读一下。读完了。");
  });
});

describe("§11.5 attach 与 run_start", () => {
  it("run/attaching 立刻给出 runId(停止按钮刷新后仍可用),历史不动", () => {
    const loaded = chatProjectionReducer(initialChatProjection, {
      type: "thread/loaded",
      rows: [row(userMessage("u1", "hi"))]
    });

    const attached = chatProjectionReducer(loaded, { type: "run/attaching", runId: "r1", assistantId: "a1" });

    expect(attached.runId).toBe("r1");
    expect(attached.isStreaming).toBe(true);
    expect(attached.streaming).toEqual({ id: "a1", role: "assistant", parts: [] });
    expect(attached.committed).toBe(loaded.committed);
  });

  it("run/opening 时 runId 还是 null,要等 run/started 才知道", () => {
    const opened = chatProjectionReducer(initialChatProjection, { type: "run/opening", assistantId: "a1" });
    expect(opened.runId).toBeNull();
    expect(opened.isStreaming).toBe(true);

    const started = chatProjectionReducer(opened, { type: "run/started", runId: "r1", threadId: "t1" });

    expect(started.runId).toBe("r1");
    expect(started.sessionId).toBe("t1");
    // 新会话的第一轮:sessionId 由 run_start 帧回填,在飞气泡不受影响。
    expect(started.streaming).toBe(opened.streaming);
  });
});

describe("§11.5 tool card 正常终止", () => {
  it("tool-call → tool-result 让卡片落到 output-available,并带上分段计时", () => {
    const opened = chatProjectionReducer(initialChatProjection, { type: "run/opening", assistantId: "a1" });
    const { states } = replay(opened, "a1", RUN_EVENTS);

    const duringCall = states[6]?.streaming?.parts.find((p) => p.type === "dynamic-tool");
    expect(duringCall).toMatchObject({ state: "input-available", toolName: "read_file", input: { path: "a.ts" } });

    const settled = states[7]?.streaming?.parts.find((p) => p.type === "dynamic-tool");
    expect(settled).toMatchObject({
      state: "output-available",
      toolCallId: "c1",
      output: "ok",
      toolMetadata: { toolExecMs: 12 }
    });
  });

  it("工具报错落到 output-error,errorText 可见", () => {
    const opened = chatProjectionReducer(initialChatProjection, { type: "run/opening", assistantId: "a1" });
    const { states } = replay(opened, "a1", [
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "ls" } },
      { type: "tool-result", toolCallId: "c1", toolName: "bash", output: "boom", status: "error" }
    ]);

    expect(states[1]?.streaming?.parts[0]).toMatchObject({
      type: "dynamic-tool",
      state: "output-error",
      errorText: "boom"
    });
  });

  it("工具之后的正文另起一段,不被粘回工具前那段", () => {
    const opened = chatProjectionReducer(initialChatProjection, { type: "run/opening", assistantId: "a1" });
    const { states } = replay(opened, "a1", RUN_EVENTS);
    const parts = states[states.length - 1]?.streaming?.parts ?? [];

    expect(parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text))
      .toEqual(["我来读一下。", "读完了。"]);
  });
});

describe("§11.5 approval / subagent 卡片不污染 assistant parts", () => {
  it("notice-injected 与 tool-input-* 不进 parts(通知自己是一条主链消息)", () => {
    const opened = chatProjectionReducer(initialChatProjection, { type: "run/opening", assistantId: "a1" });
    const { states } = replay(opened, "a1", [
      { type: "text-delta", textDelta: "开始" },
      { type: "tool-input-start", toolCallId: "c1", toolName: "task" },
      { type: "tool-input-delta", toolCallId: "c1", delta: '{"x":1}' },
      {
        type: "notice-injected",
        notices: [
          {
            kind: "reported",
            taskId: "t1",
            parentToolCallId: "c1",
            description: "子代理已汇报",
            text: "[子任务] 完成"
          }
        ]
      }
    ]);
    const last = states[states.length - 1]?.streaming;

    expect(last?.parts).toEqual([{ type: "text", text: "开始", state: "streaming" }]);
    expect(JSON.stringify(last?.parts)).not.toContain("子任务");
  });

  it("审批期间(tool-call 已发、tool-result 未回)卡片停在 input-available,投影不抖", () => {
    const opened = chatProjectionReducer(initialChatProjection, { type: "run/opening", assistantId: "a1" });
    const { states } = replay(opened, "a1", [
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "rm -rf x" } }
    ]);
    const pending = states[0] as ChatProjection;

    // 审批帧走的是 onApproval 通道(不进累积器):投影在这段时间完全不变。
    expect(pending.streaming?.parts[0]).toMatchObject({ state: "input-available" });
    expect(pending.isStreaming).toBe(true);
  });
});

describe("§11.5 aborted / error 半成品消息可见且有标记", () => {
  it("run/errored 把错误文本替成在飞气泡,run 还没收口(终态由 end 帧给)", () => {
    const opened = chatProjectionReducer(initialChatProjection, { type: "run/opening", assistantId: "a1" });
    const streamed = applyRunEvent(opened, new UiMessageBuilder("a1"), { type: "text-delta", textDelta: "半句" });

    const errored = chatProjectionReducer(streamed, { type: "run/errored", assistantId: "a1", message: "boom" });

    expect(errored.streaming).toEqual({
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "Error: boom", state: "done" }]
    });
    expect(errored.isStreaming).toBe(true);
    expect(errored.committed).toEqual([]);
  });

  it("停止后回灌:半成品消息留在 committed,aborted 标记随服务端行进来", () => {
    const opened = chatProjectionReducer(initialChatProjection, { type: "run/opening", assistantId: "a1" });
    const { states } = replay(opened, "a1", RUN_EVENTS.slice(0, 4));
    const stopped = chatProjectionReducer(states[states.length - 1] as ChatProjection, {
      type: "run/settled",
      message: null
    });

    const half: EvaUIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "我来读一下。", state: "done" }],
      metadata: { aborted: true }
    };
    const synced = chatProjectionReducer(stopped, { type: "thread/loaded", rows: [row(half)] });

    expect(synced.committed).toEqual([half]);
    expect(synced.committed[0]?.metadata?.aborted).toBe(true);
    expect(synced.isStreaming).toBe(false);
  });
});
