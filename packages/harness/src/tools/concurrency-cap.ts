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
