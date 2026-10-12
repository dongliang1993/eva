import type { PipelineTool } from "./tool.js";
import type { ToolExtra } from "../query/types.js";
import type { ToolTimingState } from "./tool-timing.js";

/** 只读工具的默认并发帽(Claude Code 同款默认)。 */
export const DEFAULT_READ_ONLY_CONCURRENCY = 10;

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency must be a positive integer");
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          signal?.removeEventListener("abort", cancel);
          resolve();
        };
        const cancel = () => {
          const index = this.waiters.indexOf(grant);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal?.reason);
        };
        this.waiters.push(grant);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

export const withConcurrencyCap = (
  pipelineTool: PipelineTool,
  limiter: Semaphore,
  timing?: ToolTimingState
): PipelineTool => {
  if (pipelineTool.annotations?.readOnlyHint !== true) {
    return pipelineTool;
  }

  const innerExecute = pipelineTool.execute;

  const execute: PipelineTool["execute"] = async (input, extra: ToolExtra) => {
    // 排队等待单独成段 —— 无竞争时是 0,不是 undefined。
    const queueStart = Date.now();
    const signal = extra.signal;
    const release = await limiter.acquire(signal);
    const toolCallId = extra.toolUseID;
    if (toolCallId !== undefined) {
      timing?.record(toolCallId, "queue", Date.now() - queueStart);
    }
    try {
      signal.throwIfAborted();
      return await innerExecute(input, extra);
    } finally {
      release();
    }
  };

  return { ...pipelineTool, execute };
};
