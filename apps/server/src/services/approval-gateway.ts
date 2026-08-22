import { classifyToolRisk } from "@eva/harness";
import type { ToolRisk } from "@eva/shared";

import { ApprovalRepository, type ApprovalRequestRow } from "../db/repositories/approval-repository.js";

interface PendingRequest {
  readonly runId: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly args: unknown;
  /** T14:ask 时即时算一次,SSE 与 listApprovals 两条路径共用这份画像。 */
  readonly risk: ToolRisk;
  resolve: (allowed: boolean) => void;
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
  /** T14:风险画像,SSE 事件里的 risk 与这里一致。 */
  readonly risk: ToolRisk;
}

/**
 * 审批网关 —— 危险工具执行前的闸门。
 *
 * - `ask()` 把审批请求落库(pending),并返回一个 Promise;
 * - 同进程内用内存 Map 待决表桥接阻塞的 agent tool 与异步的用户决策。
 *
 * **审批永远等人,不超时。** 出口只有三个:
 *   ① `decide()` —— 用户点了允许/拒绝;
 *   ② `cancelByRun()` —— 用户点停止,或 run 收尾;
 *   ③ 进程重启 —— 内存 Map 随进程消失,DB 里的 pending 行由启动清扫
 *      (`ApprovalRepository.failStalePending`,见 deps.ts)收成 denied。
 *
 * 为什么删掉了 5 分钟自动拒绝:SSE 断连不再 abort run 之后,「刷新页面 → 卡片
 * 回来 → 慢慢看清楚再决定」是正常用法,倒计时会把这条路重新掐断。代价是
 * 卡在审批上的 run 一直是 running,该会话因此被 409 挡住新消息 —— 所以侧栏的
 * requires_action 圆点与 Stop 按钮从「体验」升级成「功能」。
 *
 * 信任模型(04 §5.2):本机进程是自己人,审批只防「AI 乱来」。
 */

export class ApprovalGateway {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly repo: ApprovalRepository) {}

  /**
   * 子代理的自动通过分支(docs 04 §8.6.1 分支 2)。
   *
   * 与 ask() 的唯一区别:不等用户 —— 落库即 granted,返回 true。
   * 仍然落库:审批表是"危险工具做过什么"的唯一台账,自动通过也必须可追溯。
   * 不进 pending Map:没有待决态,cancelByRun 自然碰不到它。
   */
  autoApprove(callId: string, input: ApprovalAskInput, reason?: string): boolean {
    this.repo.create({ id: callId, ...input });
    this.repo.decide(callId, "granted", reason);
    return true;
  }

  /** 发起一次审批请求,返回解析为「是否允许」的 Promise。 */
  ask(callId: string, input: ApprovalAskInput): Promise<boolean> {
    this.repo.create({ id: callId, ...input });

    return new Promise<boolean>((resolve) => {
      this.pending.set(callId, {
        ...input,
        risk: classifyToolRisk(input.tool, (input.args ?? {}) as Record<string, unknown>),
        resolve
      });
    });
  }

  /** 按 callId 查台账行(T30:决策回写/approval_resolved 帧的数据源)。 */
  getRequest(callId: string): ApprovalRequestRow | undefined {
    return this.repo.getById(callId);
  }

  /** 前端提交决策:允许或拒绝。该请求不存在(已决策/已取消/跨进程)时返回 false。 */
  decide(callId: string, allowed: boolean): boolean {
    const entry = this.pending.get(callId);
    if (!entry) return false;

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
      out.push({
        callId,
        runId: entry.runId,
        tool: entry.tool,
        args: entry.args,
        risk: entry.risk
      });
    }
    return out;
  }
}