import { formatSubagentNotice, type SubagentNotice } from "@eva/harness";
import type { RunInjectedNotice } from "@eva/shared";

type Waiter = (notices: readonly RunInjectedNotice[]) => void;

/**
 * 子代理回报网关(S7 push)—— 一个 run 一个实例。
 *
 * 主 agent 说完话准备收尾时问一次 `drain()`:
 * - 已有通知 → 立刻全部交出,loop 注入后续跑一圈;
 * - 没有但还有存活的后台子代理 → 最多等 graceMs(它可能马上就报);
 * - 没有也没有存活任务 → 立刻空手返回,不拖慢正常收尾。
 *
 * 为什么是 per-run 而不是全局:一次 HTTP = 一个 run,SSE 随 run 关闭。晚于本 run
 * 的报告注入不进任何在飞的对话,那时通知只留在 DB(卡片可展开看)。所以网关和 run
 * 同寿,run 一结束就整体丢弃 —— 不需要跨 run 的持久队列。
 *
 * 与 ApprovalGateway 同构(进程内 Map/队列桥接异步事件),区别是这里不落库:
 * 事实(任务状态与结果)已经在 background_tasks 表,队列只是"本轮还没消费"的游标。
 */
export class ReportGateway {
  private readonly queue: RunInjectedNotice[] = [];
  private readonly waiters = new Set<Waiter>();
  private timer: NodeJS.Timeout | undefined;

  /**
   * @param hasLiveTasks 该 run 下是否还有 running 的后台子代理。没有存活任务时
   *   drain 不必等 —— 等下去也不会有人来报。
   */
  constructor(private readonly hasLiveTasks: () => boolean) {}

  /** 子代理 report / 结束时推一条通知。有人在等就立刻唤醒。 */
  push(notice: SubagentNotice): void {
    this.queue.push({
      kind: notice.kind,
      taskId: notice.taskId,
      parentToolCallId: notice.parentToolCallId,
      description: notice.description,
      text: formatSubagentNotice(notice)
    });

    this.flushWaiters();
  }

  /** 取走当前全部待注入通知(取完即清)。 */
  private take(): readonly RunInjectedNotice[] {
    if (this.queue.length === 0) return [];
    return this.queue.splice(0, this.queue.length);
  }

  private flushWaiters(): void {
    if (this.waiters.size === 0 || this.queue.length === 0) return;

    const notices = this.take();
    const pending = [...this.waiters];
    this.waiters.clear();
    this.clearTimer();

    // 第一个 waiter 拿走全部;并发 drain 不是预期用法(一个 run 只有一条 loop)。
    for (const [index, waiter] of pending.entries()) {
      waiter(index === 0 ? notices : []);
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  drain({ graceMs }: { graceMs: number }): Promise<readonly RunInjectedNotice[]> {
    // 已经有货 → 立刻走,不进等待路径。
    if (this.queue.length > 0) {
      return Promise.resolve(this.take());
    }

    // 没有存活任务就没有等的意义 —— 正常对话每轮都会走到这里,绝不能白等 graceMs。
    if (!this.hasLiveTasks()) {
      return Promise.resolve([]);
    }

    return new Promise<readonly RunInjectedNotice[]>((resolve) => {
      const waiter: Waiter = (notices) => resolve(notices);
      this.waiters.add(waiter);

      this.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        this.timer = undefined;
        // 超时:子代理还在跑但没报。本轮不注入(它的结果仍会落库)。
        resolve(this.take());
      }, graceMs);
      // 纯可弃的等待:别让这个 timer 把进程吊住。
      this.timer.unref?.();
    });
  }

  /** run 收尾:唤醒所有等待者并弃掉计时器(避免悬挂的 Promise)。 */
  dispose(): void {
    const pending = [...this.waiters];
    this.waiters.clear();
    this.clearTimer();
    for (const waiter of pending) waiter([]);
  }
}
