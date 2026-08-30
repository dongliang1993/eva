import { describe, expect, it } from "vitest";

import { DeltaAccumulator } from "../../../apps/web/src/shared/streaming/delta-accumulator.js";
import type { StreamEvent } from "../../../apps/web/src/shared/streaming/types.js";

const ev = (seq: number, content: string): StreamEvent => ({
  type: "text-delta",
  seq,
  content
});

describe("DeltaAccumulator", () => {
  it("consumes monotonically increasing events in order", () => {
    const acc = new DeltaAccumulator();

    expect(acc.push(ev(1, "a"))).toEqual([ev(1, "a")]);
    expect(acc.push(ev(2, "b"))).toEqual([ev(2, "b")]);
    expect(acc.push(ev(3, "c"))).toEqual([ev(3, "c")]);
    expect(acc.currentSeq()).toBe(3);
    expect(acc.pendingCount()).toBe(0);
  });

  it("drops duplicates (seq <= lastSeq)", () => {
    const acc = new DeltaAccumulator();
    acc.push(ev(1, "a"));
    acc.push(ev(2, "b"));

    expect(acc.push(ev(1, "a"))).toEqual([]); // 已消费
    expect(acc.push(ev(2, "b"))).toEqual([]); // 已消费
    expect(acc.push(ev(0, "x"))).toEqual([]); // 早于游标
  });

  it("buffers out-of-order events and flushes once the gap closes", () => {
    const acc = new DeltaAccumulator();
    acc.push(ev(1, "a"));

    // seq=3 先到, 缺 seq=2 → 进 pending
    expect(acc.push(ev(3, "c"))).toEqual([]);
    expect(acc.pendingCount()).toBe(1);

    // seq=2 补齐 → 一次释放 2,3
    expect(acc.push(ev(2, "b"))).toEqual([
      ev(2, "b"),
      ev(3, "c")
    ]);
    expect(acc.pendingCount()).toBe(0);
    expect(acc.currentSeq()).toBe(3);
  });

  it("keeps only the first instance of a duplicate pending seq", () => {
    const acc = new DeltaAccumulator();
    acc.push(ev(1, "a"));

    acc.push(ev(3, "c"));
    // seq=3 已 pending, 重复推送不应改变单次消费语义
    acc.push(ev(3, "c"));
    expect(acc.pendingCount()).toBe(1);

    const released = acc.push(ev(2, "b"));
    expect(released).toEqual([ev(2, "b"), ev(3, "c")]);
  });

  it("releases a long gap continuation once the missing seq arrives", () => {
    const acc = new DeltaAccumulator();
    acc.push(ev(1, "a"));

    acc.push(ev(5, "e")); // pending 3,4,5(实际缺 2~4)
    acc.push(ev(4, "d"));
    acc.push(ev(3, "c"));
    expect(acc.pendingCount()).toBe(3);

    const released = acc.push(ev(2, "b"));
    expect(released.map((e) => e.content)).toEqual(["b", "c", "d", "e"]);
    expect(acc.currentSeq()).toBe(5);
    expect(acc.pendingCount()).toBe(0);
  });
});