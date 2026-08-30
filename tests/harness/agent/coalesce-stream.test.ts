import { describe, expect, it } from "vitest";

import { coalesceTextDeltas } from "../../../packages/harness/src/agents/coalesce-stream.js";
import type { AgentStreamEvent } from "../../../packages/harness/src/agents/types.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const td = (textDelta: string): AgentStreamEvent => ({
  type: "text-delta",
  textDelta
});

const rd = (textDelta: string): AgentStreamEvent => ({
  type: "reasoning-delta",
  textDelta
});

const stepStart = (step: number): AgentStreamEvent => ({
  type: "step-start",
  step
});

const finish = (text: string): AgentStreamEvent => ({
  type: "finish",
  text,
  toolCalls: [],
  finishReason: "stop"
});

async function* fromArray(
  events: AgentStreamEvent[],
  delayMs = 0
): AsyncGenerator<AgentStreamEvent> {
  for (const event of events) {
    if (delayMs > 0) await sleep(delayMs);
    yield event;
  }
}

async function* pending(): AsyncGenerator<AgentStreamEvent> {
  yield td("a");
  yield td("b");
  await new Promise(() => {});
}

async function collect(
  events: AsyncIterable<AgentStreamEvent>
): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const event of coalesceTextDeltas(events)) {
    out.push(event);
  }
  return out;
}

describe("coalesceTextDeltas", () => {
  it("emits the first delta immediately as its own frame instead of merging it", async () => {
    const gen = coalesceTextDeltas(pending());

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual(td("a"));

    const second = await Promise.race([
      gen.next(),
      sleep(500).then(() => "timeout" as const)
    ]);
    expect(second).not.toBe("timeout");
    if (second !== "timeout" && !second.done) {
      expect(second.value).toEqual(td("b"));
    }

    await gen.return(undefined);
  });

  it("merges consecutive deltas within the window into one frame", async () => {
    const out = await collect(fromArray([td("a"), td("b"), td("c")]));

    expect(out).toEqual([td("a"), td("bc")]);
  });

  it("flushes the buffered frame when a non-delta event arrives", async () => {
    const out = await collect(
      fromArray([td("a"), td("b"), stepStart(1), finish("done")], 5)
    );

    expect(out).toEqual([td("a"), td("b"), stepStart(1), finish("done")]);
  });

  it("coalesces text and reasoning independently, never mixing channels", async () => {
    const out = await collect(fromArray([td("t1"), rd("r1"), td("t2"), rd("r2")]));

    expect(out).toEqual([td("t1"), rd("r1"), td("t2"), rd("r2")]);
    const merged = out.filter(
      (e) => e.type === "text-delta" && e.textDelta.length > 2
    );
    expect(merged).toHaveLength(0);
  });

  it("flushes the pending buffer when the source ends", async () => {
    const out = await collect(fromArray([td("a"), td("b")], 10));

    expect(out).toEqual([td("a"), td("b")]);
  });

  it("passes non-delta events through unchanged", async () => {
    const out = await collect(fromArray([stepStart(0), finish("ok")]));

    expect(out).toEqual([stepStart(0), finish("ok")]);
  });
});
