import { describe, expect, it } from "vitest";

import type { TrajectoryRow } from "../../../apps/web/src/features/threads/trajectory/derive-trajectory";
import { buildDisplayList } from "../../../apps/web/src/features/threads/trajectory/display-list.js";

const row = (
  runId: string,
  kind: TrajectoryRow["kind"],
  seq: number,
  overrides: Partial<TrajectoryRow> = {}
): TrajectoryRow => ({
  key: `${runId}:${kind}:${seq}`,
  kind,
  runId,
  seq,
  agent: "main",
  turnIndex: 0,
  stepIndex: 0,
  title: `${kind}-${seq}`,
  startedAtMs: 1000 + seq,
  durationMs: null,
  ...overrides
});

const NO_FOLD = { foldedRuns: new Set<string>(), foldedAssistants: new Set<string>() };

describe("buildDisplayList:Run 边界与折叠", () => {
  it("每个 Run 分组第一行带 Turn N 角标;分组之间有分割线;首个 Run 前不插", () => {
    const items = buildDisplayList(
      [
        row("run-a", "user", 0),
        row("run-a", "assistant", 1),
        row("run-b", "user", 2),
        row("run-b", "assistant", 3)
      ],
      NO_FOLD
    );

    const rowItems = items.filter((i) => i.type === "row");
    // 每组第一行 isRunStart + ordinal
    expect(rowItems[0]).toMatchObject({ isRunStart: true, runOrdinal: 1 });
    expect(rowItems[1]).toMatchObject({ isRunStart: false, runOrdinal: 1 });
    expect(rowItems[2]).toMatchObject({ isRunStart: true, runOrdinal: 2 });
    expect(rowItems[3]).toMatchObject({ isRunStart: false, runOrdinal: 2 });

    // 一条分割线,在 run-b 分组之前
    const dividers = items.filter((i) => i.type === "run-divider");
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toMatchObject({ runId: "run-b", ordinal: 2 });
    // 位置:run-a 的行之后、run-b 的行之前
    const dividerIndex = items.indexOf(dividers[0]!);
    expect(items[dividerIndex - 1]).toMatchObject({ type: "row", runOrdinal: 1 });
    expect(items[dividerIndex + 1]).toMatchObject({ type: "row", runOrdinal: 2, isRunStart: true });
  });

  it("折叠一个 Run:它的行全部隐藏(分割线还在,带行数),别的 Run 不受影响", () => {
    const items = buildDisplayList(
      [
        row("run-a", "user", 0),
        row("run-a", "assistant", 1),
        row("run-b", "user", 2),
        row("run-b", "assistant", 3)
      ],
      { foldedRuns: new Set(["run-b"]), foldedAssistants: new Set() }
    );

    const rowItems = items.filter((i) => i.type === "row");
    expect(rowItems.every((i) => i.row.runId === "run-a")).toBe(true);
    const divider = items.find((i) => i.type === "run-divider");
    expect(divider).toMatchObject({ runId: "run-b", folded: true, hiddenCount: 2 });
  });

  it("单 Run 无分割线;行都带 Turn 1 角标起点", () => {
    const items = buildDisplayList(
      [row("run-a", "user", 0), row("run-a", "assistant", 1)],
      NO_FOLD
    );
    expect(items.some((i) => i.type === "run-divider")).toBe(false);
    const rowItems = items.filter((i) => i.type === "row");
    expect(rowItems[0]).toMatchObject({ isRunStart: true, runOrdinal: 1 });
  });
});
