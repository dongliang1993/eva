import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Clock3, Download, Search } from "lucide-react";

import { withLoopbackToken } from "../../../shared/api/auth";
import { useRunTrajectory, useTrajectory, type TrajectoryState } from "./use-trajectory";
import { buildDisplayList, type DisplayItem, type FoldState } from "./display-list";
import type { TrajectoryRow } from "./derive-trajectory";
import { LedgerRow, RunDivider } from "./ledger-row";
import { TrajectoryOverview } from "./overview";
import { Inspector } from "./inspector";
import { resolveSnapshotForRow } from "./snapshot";

const formatMs = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

// ---------------------------------------------------------------------------
// Ledger(虚拟化台账,会话轨迹与子 Run 轨迹共用)
// ---------------------------------------------------------------------------

interface LedgerProps {
  readonly items: readonly DisplayItem[];
  readonly selectedKey: string | null;
  readonly focusKey: string | null;
  readonly highlightKeys: ReadonlySet<string>;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly onLoadOlder: () => void;
  readonly onSelect: (key: string) => void;
  readonly onToggleRun: (runId: string) => void;
  readonly onToggleAssistant: (key: string) => void;
  readonly openAtBottom: boolean;
}

function Ledger({
  items,
  selectedKey,
  focusKey,
  highlightKeys,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onSelect,
  onToggleRun,
  onToggleAssistant,
  openAtBottom
}: LedgerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
    overscan: 10,
    getItemKey: (index) => items[index]!.key
  });

  // 跳转(Overview 段点击 / 搜索命中 / 子 Run 返回):滚到目标行并选中。
  useEffect(() => {
    if (focusKey === null) return;
    const index = items.findIndex((item) => item.key === focusKey);
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: "center" });
    }
  }, [focusKey, items, virtualizer]);

  // 首屏从尾部打开(长轨迹默认看最新)。
  const openedOnceRef = useRef(false);
  useLayoutEffect(() => {
    if (openAtBottom && !openedOnceRef.current && items.length > 0 && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      openedOnceRef.current = true;
    }
  }, [items.length, openAtBottom]);

  // prepend 旧页不跳:loadOlder 只让列表向上长,按 totalSize 差值补 scrollTop。
  const prependSnapshotRef = useRef<{ totalSize: number } | null>(null);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasOlder || loadingOlder) return;
    if (el.scrollTop < 120) {
      prependSnapshotRef.current = { totalSize: virtualizer.getTotalSize() };
      onLoadOlder();
    }
  }, [hasOlder, loadingOlder, onLoadOlder, virtualizer]);

  useLayoutEffect(() => {
    const snapshot = prependSnapshotRef.current;
    const el = scrollRef.current;
    if (snapshot === null || el === null) return;
    prependSnapshotRef.current = null;
    const delta = virtualizer.getTotalSize() - snapshot.totalSize;
    if (delta > 0) {
      el.scrollTop += delta;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
      {hasOlder && (
        <div className="py-2 text-center text-xs text-muted-foreground">
          {loadingOlder ? "加载更旧的记录…" : "向上滚动加载更旧的记录"}
        </div>
      )}
      <div
        style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index]!;
          return (
            <div
              key={item.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start}px)`
              }}
            >
              {item.type === "run-divider" ? (
                <RunDivider item={item} onToggleRun={onToggleRun} />
              ) : (
                <LedgerRow
                  item={item}
                  selected={selectedKey === item.key}
                  highlighted={highlightKeys.has(item.key)}
                  onSelect={onSelect}
                  onToggleAssistant={onToggleAssistant}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 搜索(只搜已加载页 —— UI 上明说,别让用户以为没命中就是没有)
// ---------------------------------------------------------------------------

const rowMatches = (row: TrajectoryRow, query: string): boolean =>
  row.title.toLowerCase().includes(query) ||
  JSON.stringify(row.payload ?? {}).toLowerCase().includes(query);

// ---------------------------------------------------------------------------
// 会话轨迹(T53 + T54)
// ---------------------------------------------------------------------------

function SessionTrajectory({
  sessionId,
  onOpenSubRun
}: {
  readonly sessionId: string;
  readonly onOpenSubRun: (runId: string) => void;
}) {
  const state = useTrajectory(sessionId, true);
  return (
    <TrajectoryBody
      state={state}
      sessionId={sessionId}
      onOpenSubRun={onOpenSubRun}
    />
  );
}

function TrajectoryBody({
  state,
  sessionId,
  onOpenSubRun
}: {
  readonly state: TrajectoryState;
  readonly sessionId?: string;
  readonly onOpenSubRun?: (runId: string) => void;
}) {
  const { rows, events, loading, loadingOlder, hasOlder, loadOlder, error } = state;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [foldedRuns, setFoldedRuns] = useState<ReadonlySet<string>>(new Set());
  const [foldedAssistants, setFoldedAssistants] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);

  const fold: FoldState = useMemo(
    () => ({ foldedRuns, foldedAssistants }),
    [foldedRuns, foldedAssistants]
  );
  const items = useMemo(() => buildDisplayList(rows, fold), [rows, fold]);

  const toggle = useCallback(
    (setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>) =>
      (key: string) =>
        setter((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        }),
    []
  );
  const toggleRun = useMemo(() => toggle(setFoldedRuns), [toggle]);
  const toggleAssistant = useMemo(() => toggle(setFoldedAssistants), [toggle]);

  const jumpToKey = useCallback((key: string) => {
    setFocusKey(key);
    setSelectedKey(key);
  }, []);

  const matchKeys = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    return items
      .filter((item) => item.type === "row" && rowMatches(item.row, q))
      .map((item) => item.key);
  }, [items, query]);

  const jumpMatch = useCallback(
    (direction: 1 | -1) => {
      if (matchKeys.length === 0) return;
      const next = (matchCursor + direction + matchKeys.length) % matchKeys.length;
      setMatchCursor(next);
      jumpToKey(matchKeys[next]!);
    },
    [matchCursor, matchKeys, jumpToKey]
  );

  const selectedRow = useMemo(
    () => rows.find((row) => row.key === selectedKey) ?? null,
    [rows, selectedKey]
  );
  // 搜索命中集合(高亮用)。必须在 JSX 之前 —— 写进 JSX 里就是「渲染路径决定 hook
  // 数量」的违规(loading/error 早退时少调一个 hook,React 直接炸)。
  const highlightKeys = useMemo(() => new Set(matchKeys), [matchKeys]);
  const snapshotPayload = useMemo(
    () =>
      selectedRow && selectedRow.kind === "tool"
        ? resolveSnapshotForRow(events, selectedRow.runId, selectedRow.seq)
        : undefined,
    [events, selectedRow]
  );

  const downloadLog = useCallback(async () => {
    if (!sessionId) return;
    const headers = await withLoopbackToken();
    const response = await fetch(`/api/v1/threads/${sessionId}/session-log`, { headers });
    if (!response.ok) return;
    const text = await response.text();
    const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `session-${sessionId}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [sessionId]);

  // 工具栏(DSH TrajectoryToolbar 同款):Duration = 时间轴等宽/真实时长开关;
  // Turns = 全部 Turn 折叠/展开;Calls = 全部 Assistant 名下 Tool 调用折叠/展开。
  const [actualDuration, setActualDuration] = useState(true);
  const allRunIds = useMemo(
    () => [...new Set(rows.map((row) => row.runId))],
    [rows]
  );
  const allAssistantKeys = useMemo(
    () => rows.filter((row) => row.kind === "assistant").map((row) => row.key),
    [rows]
  );
  const allRunsFolded = allRunIds.length > 0 && allRunIds.every((id) => foldedRuns.has(id));
  const allAssistantsFolded =
    allAssistantKeys.length > 0 && allAssistantKeys.every((key) => foldedAssistants.has(key));

  const toggleAllRuns = useCallback(() => {
    setFoldedRuns((prev) => (allRunsFolded ? new Set() : new Set(allRunIds)));
  }, [allRunsFolded, allRunIds]);
  const toggleAllAssistants = useCallback(() => {
    setFoldedAssistants((prev) =>
      allAssistantsFolded ? new Set() : new Set(allAssistantKeys)
    );
  }, [allAssistantsFolded, allAssistantKeys]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        加载轨迹…
      </div>
    );
  }
  if (error !== null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-destructive">{error}</div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        这个会话还没有轨迹 —— 跑一轮之后,这里能看到每一步发生了什么。
      </div>
    );
  }

  const chipClass = (active: boolean): string =>
    `flex h-6 items-center gap-1 rounded px-2 text-xs transition-colors ${
      active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
    }`;

  return (
    <>
      {/* 固定工具栏(DSH 同款):Duration · Turns · Calls · Search · Session log。
          左右内边距与台账行 px-3 对齐;控件统一 h-6 保证垂直居中。 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <button
          type="button"
          className={chipClass(actualDuration)}
          aria-pressed={actualDuration}
          title={actualDuration ? "切换为等宽顺序" : "切换为真实时长"}
          onClick={() => setActualDuration((prev) => !prev)}
        >
          <Clock3 size={12} />
          Duration
        </button>
        <button
          type="button"
          className={chipClass(allRunsFolded)}
          aria-pressed={allRunsFolded}
          title={allRunsFolded ? "展开全部 Turn" : "折叠全部 Turn"}
          onClick={toggleAllRuns}
        >
          <span aria-hidden="true">{allRunsFolded ? "⊞" : "⊟"}</span>
          Turns
        </button>
        <button
          type="button"
          className={chipClass(allAssistantsFolded)}
          aria-pressed={allAssistantsFolded}
          title={allAssistantsFolded ? "展开全部 Tool 调用" : "折叠全部 Tool 调用"}
          onClick={toggleAllAssistants}
        >
          <span aria-hidden="true">{allAssistantsFolded ? "⊞" : "⊟"}</span>
          Calls
        </button>
        <div className="ml-auto flex items-center gap-1">
          <Search size={12} className="text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatchCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") jumpMatch(event.shiftKey ? -1 : 1);
            }}
            placeholder="搜索已加载页"
            title="只搜索已加载的页 —— 更旧的数据先向上滚动加载;服务端全文检索是第二阶段的事"
            className="h-6 w-32 rounded-md border border-border bg-transparent px-2 text-xs outline-none focus:border-foreground/30"
          />
          {query.trim().length > 0 && (
            <>
              <span className="text-[11px]">{matchKeys.length === 0 ? "0/0" : `${matchCursor + 1}/${matchKeys.length}`}</span>
              <button type="button" className="flex h-6 items-center px-1 hover:text-foreground" onClick={() => jumpMatch(-1)}>↑</button>
              <button type="button" className="flex h-6 items-center px-1 hover:text-foreground" onClick={() => jumpMatch(1)}>↓</button>
            </>
          )}
          {sessionId && (
            <button
              type="button"
              onClick={() => void downloadLog()}
              title="下载 session log(JSONL)"
              className="ml-1 flex h-6 items-center gap-1 rounded-md border border-border px-2 hover:bg-accent/50"
            >
              <Download size={12} />
              Session log
            </button>
          )}
        </div>
      </div>

      <TrajectoryOverview rows={rows} onJump={jumpToKey} actualDuration={actualDuration} />

      <div className="flex min-h-0 flex-1">
        <Ledger
          items={items}
          selectedKey={selectedKey}
          focusKey={focusKey}
          highlightKeys={highlightKeys}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlder}
          onSelect={setSelectedKey}
          onToggleRun={toggleRun}
          onToggleAssistant={toggleAssistant}
          openAtBottom
        />
        {selectedRow !== null && (
          <Inspector
            row={selectedRow}
            snapshotPayload={snapshotPayload}
            {...(onOpenSubRun !== undefined ? { onOpenSubRun } : {})}
            onClose={() => setSelectedKey(null)}
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 子 Run 轨迹(T54:Subtool 展开。返回时父视图保持挂载,选中行不丢)
// ---------------------------------------------------------------------------

function RunTrajectory({ runId, onBack }: { readonly runId: string; readonly onBack: () => void }) {
  const state = useRunTrajectory(runId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5 text-xs">
      <button
        type="button"
        onClick={onBack}
        className="rounded-md border border-border px-2 py-0.5 hover:bg-accent/50"
      >
        ← 返回会话轨迹
      </button>
        <span className="text-muted-foreground">子 Run {runId.slice(0, 8)}</span>
      </div>
      <TrajectoryBody state={state} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 会话内轨迹页(T53/T54)
// ---------------------------------------------------------------------------

export function TrajectoryView({ sessionId }: { readonly sessionId: string }) {
  const [runOverride, setRunOverride] = useState<string | null>(null);

  // 会话切换时退出子 Run 视图。
  const [lastSessionId, setLastSessionId] = useState(sessionId);
  if (sessionId !== lastSessionId) {
    setLastSessionId(sessionId);
    setRunOverride(null);
  }

  return (
    <>
      <div className={runOverride === null ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <SessionTrajectory sessionId={sessionId} onOpenSubRun={setRunOverride} />
      </div>
      {runOverride !== null && (
        <RunTrajectory runId={runOverride} onBack={() => setRunOverride(null)} />
      )}
    </>
  );
}
