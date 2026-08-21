/**
 * T23 乐观写守卫:Claude Code 式 mtime 快照比对。
 *
 * edit/write 是跨 await 的 read-modify-write,SDK 对同一步的 tool call
 * 并发执行(Promise.all)—— 两个 edit 打同一文件时后写基于旧快照整文件
 * 覆盖,先到的改动被静默抹掉。守卫不锁不排队:写前重新 stat 比对
 * (mtimeMs + size 双因子),变了就拒,让模型重读重试。
 * 细节见 docs/plans/r6/T23-write-guard-mtime.md。
 */

/** 目标文件某一刻的身份。size 补位粗粒度 mtime 的同窗漏检,反之亦然;
 * ctimeMs 是内核维护的时间戳,utimes 恢复不了 —— "抹掉 mtime 痕迹"的
 * 等长改写也必然推动 ctime,第三因子就是为这个兜底。 */
export interface FileSnapshot {
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly size: number;
}

export const snapshotOf = (st: {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}): FileSnapshot => ({
  mtimeMs: st.mtimeMs,
  ctimeMs: st.ctimeMs,
  size: st.size,
});

export const isStale = (a: FileSnapshot, b: FileSnapshot): boolean =>
  a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs || a.size !== b.size;

/** 拒绝文案:与 Claude Code 同义,补 retry 指引(模型侧自愈路径)。 */
export const staleFileMessage = (rel: string): string =>
  `Error: ${rel} was modified since it was read (by a concurrent tool call or ` +
  `an external process). Re-read the file and retry your edit.`;
