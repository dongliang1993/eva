import { ApprovalRepository } from "../db/repositories/approval-repository.js";

interface PendingRequest {
  readonly runId: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly args: unknown;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

/** 一次审批请求的归属与内容。 */
export interface ApprovalAskInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly args: unknown;
}

export interface PendingApprovalView {
  readonly callId: string;
  readonly runId: string;
  readonly tool: string;
  readonly args: unknown;
}

/**
 * 审批网关 —— 危险工具执行前的闸门。
 *
 * - `ask()` 把审批请求落库(pending),并返回一个 Promise;该 Promise 由
 *   前端通过 `decide(callId, allowed)` 显式 resolve,或超时后自动拒绝。
 * - 同进程内用内存 Map 待决表桥接阻塞的 agent tool 与异步的用户决策。
 *
 * 信任模型(04 §5.2):本机进程是自己人,审批只防「AI 乱来」。
 */
/** 审批挂起的上限。超时按拒绝处理,避免 run 永久吊死。 */
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

export class ApprovalGateway {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly repo: ApprovalRepository) {}

  /** 发起一次审批请求,返回解析为「是否允许」的 Promise。 */
  ask(callId: string, input: ApprovalAskInput): Promise<boolean> {
    this.repo.create({ id: callId, ...input });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        this.repo.decide(callId, "denied");
        resolve(false);
      }, PENDING_TIMEOUT_MS);

      this.pending.set(callId, { ...input, resolve, timer });
    });
  }

  /** 前端提交决策:允许或拒绝。若该请求已超时/不存在,返回 false。 */
  decide(callId: string, allowed: boolean): boolean {
    const entry = this.pending.get(callId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(callId);
    this.repo.decide(callId, allowed ? "granted" : "denied");
    entry.resolve(allowed);
    return true;
  }

  /**
   * 取消某次 run 下所有未决审批(abort / run 结束 / 进程收尾时调用)。
   * docs 14 §4.4:「abort / run 结束 / destroy 时 cancelAll 统一 reject(不会永远吊着)」。
   * 归属键是 runId 而不是 sessionId —— runId 在 run 的第一行就存在,
   * 不像 sessionId 有一段「还不知道」的窗口(那个窗口是 P0.1 的根因)。
   * @returns 被取消的数量
   */
  cancelByRun(runId: string): number {
    let cancelled = 0;

    for (const [callId, entry] of [...this.pending]) {
      if (entry.runId !== runId) {
        continue;
      }
      clearTimeout(entry.timer);
      this.pending.delete(callId);
      this.repo.decide(callId, "denied");
      entry.resolve(false);
      cancelled += 1;
    }

    return cancelled;
  }

  /** 当前未决的审批请求(供前端 SSE/轮询恢复)。 */
  listPending(sessionId?: string): readonly PendingApprovalView[] {
    const out: PendingApprovalView[] = [];
    for (const [callId, entry] of this.pending) {
      if (sessionId && entry.sessionId !== sessionId) continue;
      out.push({ callId, runId: entry.runId, tool: entry.tool, args: entry.args });
    }
    return out;
  }
}