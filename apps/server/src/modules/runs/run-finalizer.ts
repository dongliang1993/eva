import { toErrorMessage } from "@eva/shared";

import type { RunFailureLayer } from "../../db/schema.js";
import { AgentUnavailableError } from "./agent-factory.js";
import type { ApprovalGateway } from "../approvals/index.js";
import type { SessionService } from "../sessions/index.js";
import type { ReportGateway } from "../subagents/index.js";
import type { RunRegistry } from "./run-registry.js";
import type { AssistantMessageRecorder } from "./assistant-message-recorder.js";
import type { RunHub } from "./run-hub.js";
import type { RunSettlingLedger } from "./run-ledger.js";

/**
 * 流式开始**前**的失败层。"routing" = provider/模型/skill 解析,"context" = 历史/compact。
 * undefined = 已进入流式 —— 那之后的归因走 T49 的事件层,不在这里猜。
 */
export type RunFailurePhase = "routing" | "context";

export interface RunFinalizerDependencies {
  readonly runId: string;
  /** 只要终态那两个方法 —— 拿全量 RunLedger 就等于把 start/patchRouting 也带进来了。 */
  readonly runLedger: RunSettlingLedger;
  readonly session: SessionService;
  readonly runRegistry: RunRegistry;
  readonly approvals: ApprovalGateway;
  readonly hub: RunHub;
  /**
   * T49:agent 发出的失败层,由 observer 桥在运行期回填。
   * 传 ref 而不是值 —— 收尾时才读,那时它可能已经被填过了。
   */
  readonly failureLayer: { readonly current?: RunFailureLayer };
}

/**
 * 每个 run 才知道的那三样 —— 工厂把它们和进程级依赖拼起来。
 */
export interface RunFinalizerBinding {
  readonly runId: string;
  readonly hub: RunHub;
  readonly failureLayer: { readonly current?: RunFailureLayer };
}

/**
 * 由组合根提供的 finalizer 工厂。
 *
 * 为什么要这层间接:finalizer 是 per-run 的(它持 runId / hub / failureLayer),
 * 所以只能由 coordinator 在运行期建。但 §7.2 要求 coordinator **拿不到**
 * `RunSettlingLedger` —— 让它直接 new RunFinalizer 就等于让它手里有那个类型,
 * 能力收窄立刻失效。工厂把 `RunSettlingLedger` 关在组合根一侧:
 * coordinator 只拿到一个「给我这三样、还你一个 finalizer」的函数。
 *
 * 这正是宪章 §7.2「组合根注入同一个 RunLedger 实例(C8),两个窄接口只是它的两个视图」
 * 在「finalizer 是 per-run」这个事实下的具体形态。
 */
export type RunFinalizerFactory = (binding: RunFinalizerBinding) => RunFinalizer;

/** 失败收尾要知道的、只有调用方手上才有的事实。 */
export interface RunFailureContext {
  /** 空串 = 阶段①之前就失败了(连会话都没建),那时没有台账行要收。 */
  readonly sessionId: string;
  /** 本次请求新建的会话 id;503 时要撤掉它。 */
  readonly createdSessionId?: string | undefined;
  readonly phase: RunFailurePhase | undefined;
}

/**
 * 一次 Run 的终态出口 —— **唯一的一个**。
 *
 * 这个文件不是因为行数才独立的(它只有几十行),是因为「Run 的终态只有一个出口」
 * 这条不变量需要一个物理落点。把它并进 coordinator,下一个人就会在某个 catch 里
 * 顺手写一句 `runLedger.fail(...)`,于此开出第二个终态出口 —— 然后台账里开始出现
 * 「settle 过又被 fail 覆盖」的行,而没有任何测试会红。
 *
 * 三条出口互斥,各自对应一种终局:
 * - `settle()`      流式跑完(含 aborted / stream error —— 它们也是"跑完了");
 * - `fail()`        流式**开始前**就失败(装配、模型不可用、会话忙);
 * - `closeWithError()` 已经开始流式后失败,HTTP 头发不出去了,只能从 SSE 通道告知。
 *
 * `release()` 不是出口,是资源释放,三条路都要走。
 */
export class RunFinalizer {
  constructor(private readonly deps: RunFinalizerDependencies) {}

  /**
   * 正常收尾:落 assistant 消息 → 台账 settle → end 帧 → 关掉所有订阅者。
   *
   * assistantMessage 无论什么终态都落库(含 aborted / error)。丢一半的回复也比
   * DB 里没痕迹强 —— metadata.aborted 标出来即可。
   */
  settle(messageRecorder: AssistantMessageRecorder): void {
    const recorded = messageRecorder.finish();

    this.deps.runLedger.settle(this.deps.runId, {
      finishReason: recorded.finishReason,
      assistantMessageId: recorded.assistantMessageId,
      ...(recorded.usage !== undefined ? { usage: recorded.usage } : {}),
      ...(recorded.streamError !== undefined ? { error: recorded.streamError } : {}),
      ...(this.deps.failureLayer.current !== undefined
        ? { failureLayer: this.deps.failureLayer.current }
        : {})
    });

    this.deps.hub.publish({ type: "end", finishReason: recorded.finishReason });
    this.deps.hub.closeAll();
  }

  /**
   * 失败收尾:会话回滚 + 台账 fail。**不管 HTTP 状态码** —— 那是协议层的事,留在 route。
   */
  fail(error: unknown, context: RunFailureContext): void {
    // 模型不可用(503)且这条会话是本次请求刚建的 → 撤掉,别让没配好 API key 的
    // 新装用户每点一次发送就攒一条空会话。已有会话不动:用户说的话得留下。
    if (error instanceof AgentUnavailableError && context.createdSessionId) {
      this.deps.session.deleteSession(context.createdSessionId);
    }

    // 没有 sessionId = 连阶段①都没过,ledger.start 还没跑过,没有行可以收。
    if (!context.sessionId) return;

    this.deps.runLedger.fail(
      this.deps.runId,
      toErrorMessage(error),
      // 归因优先级:流式前的阶段章(phase)盖过事件层回填(failureLayer)——
      // 前者更具体,后者是上一次事件留下的,这时候未必指向本次失败。
      context.phase !== undefined
        ? { failureLayer: context.phase }
        : this.deps.failureLayer.current !== undefined
          ? { failureLayer: this.deps.failureLayer.current }
          : {}
    );
  }

  /** 已经开始流式后失败:HTTP 头早发出去了,只能从 SSE 通道告知然后收摊。 */
  closeWithError(error: unknown): void {
    this.deps.hub.publish({ type: "error", message: toErrorMessage(error) });
    this.deps.hub.publish({ type: "end", finishReason: "error" });
    this.deps.hub.closeAll();
  }

  /** 三条出口共同的资源释放。成败都要走,所以它在 finally 里。 */
  release(reportGateway: ReportGateway | undefined): void {
    // 唤醒可能还在等通知的 drain,别留悬挂 Promise。
    reportGateway?.dispose();
    this.deps.runRegistry.unregister(this.deps.runId);
    // pending 审批要么已被决策、要么被 abort 路由 cancelByRun 清掉;这里兜底。
    this.deps.approvals.cancelByRun(this.deps.runId);
  }
}
