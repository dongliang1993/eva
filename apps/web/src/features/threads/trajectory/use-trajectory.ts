import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RunEventDto,
  RunTrajectoryResponse,
  SessionTrajectoryCursor,
  SessionTrajectoryResponse,
  SubRunSummaryDto
} from "@eva/shared";

import { apiFetch } from "../../../shared/api/fetch";
import { deriveTrajectory, type TrajectoryRow } from "./derive-trajectory";

const PAGE_SIZE = 200;

export interface TrajectoryState {
  readonly rows: readonly TrajectoryRow[];
  /** 原始事件(检查器的 snapshot ref 解析要用;已脱敏)。 */
  readonly events: readonly RunEventDto[];
  readonly loading: boolean;
  readonly loadingOlder: boolean;
  readonly hasOlder: boolean;
  readonly loadOlder: () => void;
  readonly error: string | null;
}

/**
 * 轨迹数据 hook:第一页(最新)在尾部打开,向上按三元组游标翻更旧的页。
 * 游标是不透明对象,存状态里直接回传 —— 绝不在组件里手搓 occurredAtMs - 1
 * 之类的算术(契约:三元组的语义是「严格小于这一整个元组」)。
 */
export const useTrajectory = (
  sessionId: string | null,
  enabled: boolean
): TrajectoryState => {
  const [events, setEvents] = useState<readonly RunEventDto[]>([]);
  const [subRuns, setSubRuns] = useState<readonly SubRunSummaryDto[]>([]);
  const [cursor, setCursor] = useState<SessionTrajectoryCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 会话切换/竞态守卫:慢响应回来时不许覆盖新会话的数据。
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setEvents([]);
    setSubRuns([]);
    setCursor(null);

    apiFetch<SessionTrajectoryResponse>(
      `/api/v1/threads/${sessionId}/trajectory?limit=${PAGE_SIZE}`
    )
      .then((res) => {
        if (requestIdRef.current !== requestId) return;
        setEvents(res.events);
        setSubRuns(res.subRuns);
        setCursor(res.nextCursor);
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : "加载轨迹失败");
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
      });
  }, [sessionId, enabled]);

  const loadOlder = useCallback(() => {
    if (!sessionId || cursor === null || loadingOlder) return;
    const requestId = requestIdRef.current;
    setLoadingOlder(true);

    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      beforeOccurredAtMs: String(cursor.beforeOccurredAtMs),
      beforeRunId: cursor.beforeRunId,
      beforeSeq: String(cursor.beforeSeq)
    });
    apiFetch<SessionTrajectoryResponse>(
      `/api/v1/threads/${sessionId}/trajectory?${params.toString()}`
    )
      .then((res) => {
        if (requestIdRef.current !== requestId) return;
        // 旧页追加在尾部;投影内部自排序,累积顺序不影响结果。
        setEvents((prev) => [...prev, ...res.events]);
        setSubRuns(res.subRuns);
        setCursor(res.nextCursor);
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : "加载更旧的轨迹失败");
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoadingOlder(false);
      });
  }, [sessionId, cursor, loadingOlder]);

  const rows = useMemo(() => deriveTrajectory(events, subRuns), [events, subRuns]);

  return {
    rows,
    events,
    loading,
    loadingOlder,
    hasOlder: cursor !== null,
    loadOlder,
    error
  };
};

/** 单 Run 轨迹(T54 Subtool 展开):beforeSeq 翻页,单 Run 内 seq 严格递增唯一。 */
export const useRunTrajectory = (
  runId: string | null
): TrajectoryState => {
  const [events, setEvents] = useState<readonly RunEventDto[]>([]);
  const [nextBeforeSeq, setNextBeforeSeq] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEvents([]);
    setNextBeforeSeq(null);

    apiFetch<RunTrajectoryResponse>(
      `/api/v1/runs/${runId}/trajectory?limit=${PAGE_SIZE}`
    )
      .then((res) => {
        if (cancelled) return;
        setEvents(res.events);
        setNextBeforeSeq(res.nextBeforeSeq);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载子 Run 失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [runId]);

  const loadOlder = useCallback(() => {
    if (!runId || nextBeforeSeq === null || loadingOlder) return;
    setLoadingOlder(true);
    apiFetch<RunTrajectoryResponse>(
      `/api/v1/runs/${runId}/trajectory?limit=${PAGE_SIZE}&beforeSeq=${nextBeforeSeq}`
    )
      .then((res) => {
        setEvents((prev) => [...prev, ...res.events]);
        setNextBeforeSeq(res.nextBeforeSeq);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "加载更旧的记录失败");
      })
      .finally(() => setLoadingOlder(false));
  }, [runId, nextBeforeSeq, loadingOlder]);

  const rows = useMemo(() => deriveTrajectory(events, []), [events]);

  return {
    rows,
    events,
    loading,
    loadingOlder,
    hasOlder: nextBeforeSeq !== null,
    loadOlder,
    error
  };
};
