/**
 * seq 重组 accumulator（三红线 ①，01 §3.2 ① / 10 §6）。
 *
 * SSONEvents 可能乱序或重复到达。accumulator 保证按 seq 串行消费：
 * - `seq <= lastSeq` → 丢弃(重复)
 * - `seq === lastSeq + 1` → 立即处理并续推可能补齐的 pending
 * - `seq > lastSeq + 1` → 进 pendingDeltas 等缺口,由下一条续上
 *
 * 纯逻辑、无 React,避免在渲染管线里手写这份排序。
 */
import type { StreamEvent } from "./types.js";

export class DeltaAccumulator {
  private lastSeq = 0;
  private readonly pending = new Map<number, StreamEvent>();

  /**
   * 接收一个事件。返回可以按序消费的有序事件列表(0~N 条)。
   * 重复事件返回空数组;乱序事件可能先入 pending,直到缺口补齐才消费。
   */
  push(event: StreamEvent): readonly StreamEvent[] {
    if (event.seq <= this.lastSeq) {
      // 已处理过或早于当前游标 —— 丢弃
      return [];
    }

    if (event.seq === this.lastSeq + 1) {
      this.lastSeq = event.seq;
      const ready: StreamEvent[] = [event];

      // 尽量从 pending 补上连续后继
      let next = this.lastSeq + 1;
      while (this.pending.has(next)) {
        const ev = this.pending.get(next)!;
        this.pending.delete(next);
        this.lastSeq = next;
        ready.push(ev);
        next += 1;
      }

      return ready;
    }

    // 出现缺口: 先进 pending 等后继
    // 若同一 seq 已 pending(极端重复), 保留先到的
    if (!this.pending.has(event.seq)) {
      this.pending.set(event.seq, event);
    }

    return [];
  }

  /** 活动中的事件计数(含已消费游标之后尚未补全的 pending)。 */
  pendingCount(): number {
    return this.pending.size;
  }

  /** 当前已消费到的最大 seq。 */
  currentSeq(): number {
    return this.lastSeq;
  }
}