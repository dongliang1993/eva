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

/** run 台账的业务入口；route 不直接操作持久化实现。 */
export class RunLedger {
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
