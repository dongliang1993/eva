import { describe, expect, it } from "vitest";

import { STREAM_COALESCE_WINDOW_MS } from "../../../packages/harness/src/constants.js";
import { coalesceStreamEvents } from "../../../packages/harness/src/query/coalesce-stream.js";
import type { HarnessMessage } from "../../../packages/harness/src/query/types.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const td = (text: string): HarnessMessage => ({
  type: "stream_event",
  event: { type: "text_delta", text },
  parent_tool_use_id: null,
});

const rd = (text: string): HarnessMessage => ({
  type: "stream_event",
  event: { type: "reasoning_delta", text },
  parent_tool_use_id: null,
});

const stepStart = (turn: number): HarnessMessage => ({
  type: "stream_event",
  event: { type: "step_start", turn },
  parent_tool_use_id: null,
});

const assistant = (text: string): HarnessMessage => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
  turn: 0,
  parent_tool_use_id: null,
});

async function* fromArray(
  events: HarnessMessage[],
  delayMs = 0
): AsyncGenerator<HarnessMessage> {
  for (const event of events) {
    if (delayMs > 0) await sleep(delayMs);
    yield event;
  }
}

async function* pending(): AsyncGenerator<HarnessMessage> {
  yield td("a");
  yield td("b");
  await new Promise(() => {});
}

async function collect(
  events: AsyncIterable<HarnessMessage>
): Promise<HarnessMessage[]> {
  const out: HarnessMessage[] = [];
  for await (const event of coalesceStreamEvents(events)) {
    out.push(event);
  }
  return out;
}

describe("coalesceStreamEvents", () => {
  // 首帧立即发出已随 coalesceTextDeltas 删:新实现窗口内全量合并(含首帧),
  // 窗口到期才冲出 —— 同一信息由「窗口到期合并发出」覆盖。
  it("emits the buffered frame at window expiry when the source stalls", async () => {
    const gen = coalesceStreamEvents(pending());

    // 源在 yield b 之后挂起:缓冲里的 a+b 只能等窗口到期冲出。
    const first = await Promise.race([
      gen.next(),
      sleep(500).then(() => "timeout" as const),
    ]);
    expect(first).not.toBe("timeout");
    expect(first.done).toBe(false);
    expect(first.value).toEqual(td("ab"));

    // 缓冲已冲空、源仍挂起:下一帧只能等源再产 —— 超时即证(不再有立即的第二帧)。
    const second = await Promise.race([
      gen.next(),
      sleep(STREAM_COALESCE_WINDOW_MS).then(() => "timeout" as const),
    ]);
    expect(second).toBe("timeout");
    // 旧测试的 gen.return() 已去:新实现挂在永不计时的 race 上,return 永不落定。
  });

  it("merges consecutive deltas within the window into one frame", async () => {
    const out = await collect(fromArray([td("a"), td("b"), td("c")]));

    // 旧断言 [td("a"), td("bc")](首帧直发);新实现首帧也进窗口 → 全并一帧。
    expect(out).toEqual([td("abc")]);
  });

  it("flushes the buffered frame when a non-delta event arrives", async () => {
    const out = await collect(
      fromArray([td("a"), td("b"), stepStart(1), assistant("done")], 5)
    );

    // 旧断言 [td("a"), td("b"), …](a 已直发、b 被冲出);新实现 a+b 合并后冲出。
    expect(out).toEqual([td("ab"), stepStart(1), assistant("done")]);
  });

  it("coalesces text and reasoning independently, never mixing channels", async () => {
    const out = await collect(fromArray([td("t1"), rd("r1"), td("t2"), rd("r2")]));

    // 旧断言四帧各自直发;新实现同通道各并一帧,通道间仍不混。
    expect(out).toEqual([td("t1t2"), rd("r1r2")]);
    const textFrames = out.filter(
      (e) => e.type === "stream_event" && e.event.type === "text_delta"
    );
    // 混通道会出现 "t1r1" 这类帧;这里每帧只含本通道文本。
    for (const frame of textFrames) {
      expect(frame.type === "stream_event" && frame.event.type === "text_delta"
        ? frame.event.text.includes("r")
        : false).toBe(false);
    }
  });

  it("flushes the pending buffer when the source ends", async () => {
    const out = await collect(fromArray([td("a"), td("b")], 10));

    // 旧断言 [td("a"), td("b")](首帧直发);源结束时缓冲合并冲出 → 一帧。
    expect(out).toEqual([td("ab")]);
  });

  it("passes non-delta events through unchanged", async () => {
    const out = await collect(fromArray([stepStart(0), assistant("ok")]));

    expect(out).toEqual([stepStart(0), assistant("ok")]);
  });

  // 「首帧独立成帧」的存活语义:增量间隔超过窗口时,前一段不会再等后一段 ——
  // 窗口关闭即冲出,跨窗口不合并。
  it("emits deltas spaced beyond the window as separate frames", async () => {
    const out = await collect(
      fromArray([td("a"), td("b")], STREAM_COALESCE_WINDOW_MS + 50)
    );

    expect(out).toEqual([td("a"), td("b")]);
  });
});
