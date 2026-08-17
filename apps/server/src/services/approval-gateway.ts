import { ApprovalRepository } from "../db/repositories/approval-repository.js";

interface PendingRequest {
  readonly sessionId: string;
  readonly tool: string;
  readonly args: unknown;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
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
export class ApprovalGateway {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly repo: ApprovalRepository) {}

  private static readonly PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

  /** 发起一次审批请求,返回解析为「是否允许」的 Promise。 */
  ask(callId: string, sessionId: string, tool: string, args: unknown): Promise<boolean> {
    this.repo.create({ id: callId, sessionId, tool, args });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        this.repo.decide(callId, "denied");
        resolve(false);
      }, ApprovalGateway.PENDING_TIMEOUT_MS);

      this.pending.set(callId, { sessionId, tool, args, resolve, timer });
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

  /** 当前未决的审批请求(供前端 SSE/轮询发现)。 */
  listPending(sessionId?: string): ReadonlyArray<{
    callId: string;
    tool: string;
    args: unknown;
  }> {
    const out: Array<{ callId: string; tool: string; args: unknown }> = [];
    for (const [callId, entry] of this.pending) {
      if (sessionId && entry.sessionId !== sessionId) continue;
      out.push({ callId, tool: entry.tool, args: entry.args });
    }
    return out;
  }
}