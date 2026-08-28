import type { TrajectoryRow } from "./derive-trajectory";

/**
 * 展示列表构建(纯函数):投影行 → 带 Run 边界(左边角标 + 分割线)与折叠态的展示项。
 *
 * 边界单位是 Run —— turn 与 run 1:1 是常态(一个 Run 恒为 turn 0),DSH 轨迹页里
 * 那个「Turn N」角标对应的就是我们的 Run 分组。折叠态只影响显示,不销毁已加载数据。
 */

export type DisplayItem =
  | {
      readonly type: "row";
      readonly key: string;
      readonly row: TrajectoryRow;
      /** 0 = 顶层;1 = 挂在上一个 Assistant 下的 Tool;2 = 嵌套的后台子 Run。 */
      readonly depth: 0 | 1 | 2;
      /** 该 Run 在会话里的序号(1 起) —— 左边角标。 */
      readonly runOrdinal: number;
      /** 是否该 Run 分组的第一行(角标只落在它上面)。 */
      readonly isRunStart: boolean;
    }
  | {
      readonly type: "run-divider";
      readonly key: string;
      readonly runId: string;
      /** 该 Run 在会话里的序号(1 起)。 */
      readonly ordinal: number;
      readonly folded: boolean;
      /** 折叠时被隐藏的展示行数。 */
      readonly hiddenCount: number;
    };

export interface FoldState {
  /** 按 runId 折叠整轮(双击分割线)。 */
  readonly foldedRuns: ReadonlySet<string>;
  readonly foldedAssistants: ReadonlySet<string>;
}

export const buildDisplayList = (
  rows: readonly TrajectoryRow[],
  fold: FoldState
): DisplayItem[] => {
  const items: DisplayItem[] = [];
  // runId → 会话内序号(首次出现序,1 起)与行数。
  const ordinals = new Map<string, number>();
  const rowsPerRun = new Map<string, number>();
  for (const row of rows) {
    if (!ordinals.has(row.runId)) {
      ordinals.set(row.runId, ordinals.size + 1);
    }
    rowsPerRun.set(row.runId, (rowsPerRun.get(row.runId) ?? 0) + 1);
  }

  let lastAssistant: TrajectoryRow | null = null;
  let assistantHiddenTools = 0;
  const seenRuns = new Set<string>();

  const flushAssistantFoldPlaceholder = (): void => {
    if (lastAssistant !== null && assistantHiddenTools > 0) {
      // Assistant 折叠时,被藏掉的 Tool 用一条占位行提示数量(数据没丢)。
      items.push({
        type: "row",
        key: `${lastAssistant.key}:fold-placeholder`,
        depth: 1,
        runOrdinal: ordinals.get(lastAssistant.runId) ?? 0,
        isRunStart: false,
        row: {
          key: `${lastAssistant.key}:fold-placeholder`,
          kind: "raw",
          runId: lastAssistant.runId,
          seq: -1,
          agent: lastAssistant.agent,
          turnIndex: lastAssistant.turnIndex,
          stepIndex: lastAssistant.stepIndex,
          title: `${assistantHiddenTools} 个工具调用(已折叠)`,
          startedAtMs: null,
          durationMs: null
        }
      });
    }
    assistantHiddenTools = 0;
  };

  for (const row of rows) {
    const ordinal = ordinals.get(row.runId) ?? 0;
    const isRunStart = !seenRuns.has(row.runId);

    // Run 边界:每个新 Run 分组前插一条分割线(第一个 Run 之前不插)。
    if (isRunStart) {
      seenRuns.add(row.runId);
      if (ordinal > 1) {
        items.push({
          type: "run-divider",
          key: `divider:${row.runId}`,
          runId: row.runId,
          ordinal,
          folded: fold.foldedRuns.has(row.runId),
          hiddenCount: rowsPerRun.get(row.runId) ?? 0
        });
      }
    }

    // Run 折叠:该 Run 的行全部不显示(分割线还在,数据不丢)。
    if (fold.foldedRuns.has(row.runId)) {
      continue;
    }

    const isToolUnderAssistant =
      row.kind === "tool" &&
      lastAssistant !== null &&
      lastAssistant.runId === row.runId &&
      lastAssistant.stepIndex === row.stepIndex;

    // Assistant 折叠:它名下后续的 Tool 行隐藏并计数。
    if (
      row.kind === "tool" &&
      lastAssistant !== null &&
      fold.foldedAssistants.has(lastAssistant.key) &&
      lastAssistant.runId === row.runId &&
      lastAssistant.stepIndex === row.stepIndex
    ) {
      assistantHiddenTools += 1;
      continue;
    }

    // 遇到非 Tool 行:先结掉上一个 Assistant 的折叠占位。
    if (row.kind !== "tool") {
      flushAssistantFoldPlaceholder();
      lastAssistant = row.kind === "assistant" ? row : null;
    }

    items.push({
      type: "row",
      key: row.key,
      row,
      depth: isToolUnderAssistant ? 1 : 0,
      runOrdinal: ordinal,
      isRunStart
    });

    // 后台子 Run 挂在 Tool 行下(depth 2 紧跟)。
    for (const child of row.children ?? []) {
      items.push({
        type: "row",
        key: child.key,
        row: child,
        depth: 2,
        runOrdinal: ordinal,
        isRunStart: false
      });
    }
  }
  flushAssistantFoldPlaceholder();

  return items;
};
