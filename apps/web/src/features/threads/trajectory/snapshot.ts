import type { RunEventDto } from "@eva/shared";

/**
 * 取某行「调用当时」的 snapshot payload(设计文档 §4.3):
 * 同 Run 内 seq ≤ beforeSeq 的最近一条 request_snapshot;最近一条若是
 * request_snapshot_ref,顺 refSeq 取回正文。ref 只在同 Run 内有效,跨 Run 无链。
 * 找不到(页还没翻到)返回 undefined —— 检查器显示「快照在未加载页」而不是伪造。
 */
export const resolveSnapshotForRow = (
  events: readonly RunEventDto[],
  runId: string,
  beforeSeq: number
): unknown | undefined => {
  let nearestSnapshot: RunEventDto | undefined;
  let nearestRef: RunEventDto | undefined;
  const snapshotBySeq = new Map<number, RunEventDto>();

  for (const event of events) {
    if (event.runId !== runId) continue;
    if (event.kind === "request_snapshot") {
      snapshotBySeq.set(event.seq, event);
      if (event.seq <= beforeSeq) {
        nearestSnapshot = event;
        nearestRef = undefined;
      }
    } else if (event.kind === "request_snapshot_ref" && event.seq <= beforeSeq) {
      if (nearestSnapshot === undefined || event.seq > nearestSnapshot.seq) {
        nearestRef = event;
      }
    }
  }

  if (nearestRef !== undefined) {
    const refSeq = (nearestRef.payload as { refSeq?: number } | undefined)?.refSeq;
    return refSeq !== undefined ? snapshotBySeq.get(refSeq)?.payload : undefined;
  }
  return nearestSnapshot?.payload;
};
