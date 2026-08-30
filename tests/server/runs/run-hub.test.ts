import { describe, expect, it } from "vitest";
import type { FastifyReply } from "../../../apps/server/node_modules/fastify";

import type { EvaUIMessage, RunStreamFrame } from "../../../packages/shared/src/index.js";
import { UiMessageBuilder } from "../../../packages/shared/src/index.js";
import { RunEventStream } from "../../../apps/server/src/transports/sse/event-stream.js";
import { RunHub } from "../../../apps/server/src/services/runs/run-hub.js";

/** 只实现 RunEventStream 真正碰到的那几个 raw 属性。 */
interface FakeSocket {
  readonly frames: RunStreamFrame[];
  readonly stream: RunEventStream;
  kill: () => void;
  ended: () => boolean;
}

const fakeSocket = (): FakeSocket => {
  const chunks: string[] = [];
  const raw = {
    writableEnded: false,
    destroyed: false,
    writeHead: () => {},
    write: (chunk: string) => chunks.push(chunk),
    end: () => {
      raw.writableEnded = true;
    },
    on: () => {}
  };

  return {
    get frames() {
      return chunks
        .filter((chunk) => chunk.includes("data: "))
        .map((chunk) => JSON.parse(chunk.split("data: ")[1]!.trim()) as RunStreamFrame);
    },
    stream: new RunEventStream({ raw } as unknown as FastifyReply),
    kill: () => {
      raw.destroyed = true;
    },
    ended: () => raw.writableEnded
  };
};

const inFlightMessage = (): EvaUIMessage => {
  const builder = new UiMessageBuilder("m1");
  builder.push({ type: "text-delta", textDelta: "我先读一下" });
  builder.push({ type: "tool-call", toolCallId: "tc-1", toolName: "read_file", input: { path: "a" } });
  builder.push({ type: "tool-result", toolCallId: "tc-1", toolName: "read_file", output: "x", status: "success" });
  return builder.snapshot();
};

describe("RunHub", () => {
  it("publish 扇出给所有订阅者,每条连接的 seq 各自从 1 连号", () => {
    const hub = new RunHub("run-1");
    const a = fakeSocket();
    const b = fakeSocket();

    void hub.attach(a.stream, { replay: false });
    hub.publish({ type: "text-delta", textDelta: "一" });
    void hub.attach(b.stream, { replay: false });
    hub.publish({ type: "text-delta", textDelta: "二" });

    expect(a.frames.map((f) => f.seq)).toEqual([1, 2]);
    // 后来的订阅者从 1 开始 —— web 的 DeltaAccumulator 从 lastSeq=0 起严格连号。
    expect(b.frames.map((f) => f.seq)).toEqual([1]);
  });

  it("attach(replay:true) 先给 run_start,再按序补历史帧", () => {
    const hub = new RunHub("run-1");
    hub.bind({ sessionId: "session-1", snapshot: inFlightMessage });

    const late = fakeSocket();
    void hub.attach(late.stream, { replay: true });
    hub.publish({ type: "text-delta", textDelta: "继续写" });

    expect(late.frames.map((f) => f.type)).toEqual([
      "run_start",
      "text-delta",
      "tool-call",
      "tool-result",
      "text-delta"
    ]);
    expect(late.frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(late.frames[0]).toMatchObject({ runId: "run-1", sessionId: "session-1" });
  });

  it("还没开始流(无快照)时只给 run_start", () => {
    const hub = new RunHub("run-1");
    hub.bind({ sessionId: "session-1", snapshot: () => undefined });

    const late = fakeSocket();
    void hub.attach(late.stream, { replay: true });

    expect(late.frames.map((f) => f.type)).toEqual(["run_start"]);
  });

  it("detach 之后不再收帧,attach 的 promise 兑现", async () => {
    const hub = new RunHub("run-1");
    const a = fakeSocket();
    const done = hub.attach(a.stream, { replay: false });

    hub.detach(a.stream);
    hub.publish({ type: "text-delta", textDelta: "落空" });

    await expect(done).resolves.toBeUndefined();
    expect(a.frames).toHaveLength(0);
    expect(hub.subscriberCount).toBe(0);
  });

  it("closeAll 关掉所有订阅者并兑现全部 attach promise", async () => {
    const hub = new RunHub("run-1");
    const a = fakeSocket();
    const b = fakeSocket();
    const done = Promise.all([
      hub.attach(a.stream, { replay: false }),
      hub.attach(b.stream, { replay: false })
    ]);

    hub.closeAll();

    await expect(done).resolves.toEqual([undefined, undefined]);
    expect(a.ended()).toBe(true);
    expect(b.ended()).toBe(true);
    expect(hub.subscriberCount).toBe(0);
  });

  it("socket 已死时 publish/closeAll 不抛(断连后 run 才收尾是常态)", () => {
    const hub = new RunHub("run-1");
    const a = fakeSocket();
    void hub.attach(a.stream, { replay: false });

    a.kill();

    expect(() => hub.publish({ type: "text-delta", textDelta: "x" })).not.toThrow();
    expect(() => hub.closeAll()).not.toThrow();
  });

  it("run 已收尾后再 attach → 立刻关掉,不吊着调用方", async () => {
    const hub = new RunHub("run-1");
    hub.closeAll();

    const late = fakeSocket();
    await expect(hub.attach(late.stream, { replay: true })).resolves.toBeUndefined();
    expect(late.frames).toHaveLength(0);
  });
});
