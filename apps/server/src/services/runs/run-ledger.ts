import type { StreamFinishReason, StreamTokenUsage } from "@eva/shared";

import {
  DrizzleRunRepository,
  runStatusFor
} from "../../db/repositories/run-repository.js";
import type { RunFailureLayer } from "../../db/schema.js";

export interface StartRunOptions {
  readonly id: string;
  readonly sessionId: string;
  /** T48 起可选:Run 提前到模型解析前创建(路由失败也要有台账行),解析成功后 patchRouting 补上。 */
  readonly model?: string;
  readonly userMessageId?: string;
  readonly requestedModel?: string;
  readonly captureLevel?: string;
  readonly parentRunId?: string;
  readonly backgroundTaskId?: string;
}

export interface SettleRunOptions {
  readonly finishReason: StreamFinishReason;
  readonly assistantMessageId: string;
  readonly usage?: StreamTokenUsage | undefined;
  readonly error?: string | undefined;
  readonly failureLayer?: RunFailureLayer | undefined;
}

/**
 * Open 阶段能做的:建行、回填路由。**看不见 settle / fail。**
 *
 * 这不是 Port —— 别拿宪法 C6 反驳它。C6 禁止的是「为只有一个实现的类造 IXxxService
 * 以便将来替换」;这里两个接口不是为了替换,而是**能力收窄**:同一个实现的两个受限视图,
 * 目的是让调用方拿不到它不该有的方法。判别方法:Port 的两侧是不同实现,
 * 能力收窄的两侧是同一实现的子集。
 */
export interface RunOpeningLedger {
  start(input: StartRunOptions): void;
  patchRouting(runId: string, requestedModel: string, resolvedModel: string): void;
}

/**
 * 终态。**只有 RunFinalizer 拿得到这个类型。**
 *
 * 为什么用编译器守而不用 lint(§7.2):lint 只扫 import,扫不出「import 了 RunLedger
 * 之后调了 .settle()」;改成扫 `.settle(` 这种符号级文本匹配,别人把变量名从 runLedger
 * 改成 ledger 就漏了。把类型按能力切两半,TypeScript 直接拒绝 —— 更早也更准。
 *
 * 唯一的漏洞是「有人在 coordinator 里直接 import RunLedger 具体类」,那恰好是一条
 * 纯 import 规则,由 scripts/check-architecture.mjs 的 run-ledger-terminal-state 兜住。
 */
export interface RunSettlingLedger {
  settle(runId: string, options: SettleRunOptions): void;
  fail(runId: string, error: string, options?: { failureLayer?: RunFailureLayer }): void;
}

/**
 * run 台账的业务入口;route 不直接操作持久化实现。
 *
 * 组合根注入同一个实例(宪法 C8),两个窄接口只是它的两个视图:
 * coordinator 拿 RunOpeningLedger,finalizer 拿 RunSettlingLedger。
 */
export class RunLedger implements RunOpeningLedger, RunSettlingLedger {
  constructor(private readonly runs: DrizzleRunRepository) { }

  start(input: StartRunOptions): void {
    this.runs.start(input);
  }

  /** 模型解析成功后回填路由结果(requested + resolved 一次写完)。 */
  patchRouting(runId: string, requestedModel: string, resolvedModel: string): void {
    this.runs.patchRouting(runId, requestedModel, resolvedModel);
  }

  settle(runId: string, options: SettleRunOptions): void {
    this.runs.settle(runId, {
      status: runStatusFor(options.finishReason),
      finishReason: options.finishReason,
      assistantMessageId: options.assistantMessageId,
      ...(options.usage !== undefined ? { usage: options.usage } : {}),
      ...(options.error !== undefined ? { error: options.error } : {}),
      ...(options.failureLayer !== undefined ? { failureLayer: options.failureLayer } : {})
    });
  }

  fail(runId: string, error: string, options: { failureLayer?: RunFailureLayer } = {}): void {
    this.runs.settle(runId, {
      status: "error",
      error,
      ...(options.failureLayer !== undefined ? { failureLayer: options.failureLayer } : {})
    });
  }
}
