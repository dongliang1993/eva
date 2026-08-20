import type { StreamFinishReason, StreamTokenUsage } from "@eva/shared";

import {
  DrizzleRunRepository,
  runStatusFor
} from "../../db/repositories/run-repository.js";

export interface StartRunOptions {
  readonly id: string;
  readonly sessionId: string;
  readonly model: string;
  readonly userMessageId: string;
}

export interface SettleRunOptions {
  readonly finishReason: StreamFinishReason;
  readonly assistantMessageId: string;
  readonly usage?: StreamTokenUsage | undefined;
  readonly error?: string | undefined;
}

/** run 台账的业务入口；route 不直接操作持久化实现。 */
export class RunLedger {
  constructor(private readonly runs: DrizzleRunRepository) { }

  start(input: StartRunOptions): void {
    this.runs.start(input);
  }

  settle(runId: string, options: SettleRunOptions): void {
    this.runs.settle(runId, {
      status: runStatusFor(options.finishReason),
      finishReason: options.finishReason,
      assistantMessageId: options.assistantMessageId,
      ...(options.usage !== undefined ? { usage: options.usage } : {}),
      ...(options.error !== undefined ? { error: options.error } : {})
    });
  }

  fail(runId: string, error: string): void {
    this.runs.settle(runId, { status: "error", error });
  }
}
