/**
 * 旁路消息通道:工具 execute(跑在 AI SDK 的 streamText 里)产出的消息,
 * 经它并入 query() 的主流。子代理的消息走这里 —— execute 不能直接 yield 给父生成器。
 *
 * 单消费者:push 无界(子代理的产出速率由它自己的模型调用约束);
 * next() 在空队列上挂起,直到 push 或 close。
 */
export interface SideChannel<T> {
  push(item: T): void;
  /** 有待取项时立即 resolve;否则等下一次 push。close 后返回 undefined。 */
  next(): Promise<T | undefined>;
  /** 非阻塞取出全部待取项。 */
  drain(): T[];
  close(): void;
}

export const createSideChannel = <T>(): SideChannel<T> => {
  const queue: T[] = [];
  let waiter: ((item: T | undefined) => void) | undefined;
  let closed = false;

  return {
    push(item) {
      if (closed) return;
      if (waiter !== undefined) {
        const resolve = waiter;
        waiter = undefined;
        resolve(item);
        return;
      }
      queue.push(item);
    },
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    drain() {
      return queue.splice(0);
    },
    close() {
      closed = true;
      if (waiter !== undefined) {
        const resolve = waiter;
        waiter = undefined;
        resolve(undefined);
      }
    },
  };
};

/**
 * 主流 ∪ 旁路:旁路项一到即插入(不等主流的下一条)。
 *
 * 顺序:旁路优先。子代理的 push 在因果上先于父工具返回(execute 等子代理跑完),
 * 所以父的 user(tool-result) 必在子代理全部消息之后 —— 前提是两边同时就绪时先排空旁路
 * (Promise.race 对已就绪的两个 promise 会按数组序选主流,不能依赖它)。
 * 主流结束后冲掉旁路剩余;消费方提前 return 时只关通道,不再产出。
 */
export async function* mergeWithSideChannel<T>(
  main: AsyncIterator<T>,
  side: SideChannel<T>,
): AsyncGenerator<T> {
  let mainNext: Promise<IteratorResult<T>> | undefined;
  let sideNext: Promise<T | undefined> | undefined;
  try {
    for (;;) {
      yield* side.drain();
      mainNext ??= main.next();
      sideNext ??= side.next();
      const winner = await Promise.race([
        sideNext.then((item) => ({ from: "side" as const, item })),
        mainNext.then((result) => ({ from: "main" as const, result })),
      ]);
      if (winner.from === "side") {
        sideNext = undefined;
        if (winner.item !== undefined) yield winner.item;
        continue;
      }
      mainNext = undefined;
      yield* side.drain();
      if (winner.result.done) break;
      yield winner.result.value;
    }
    side.close();
    // sideNext 挂在 next() 上时,close 让它以 undefined 收尾;已到的项在 drain 里。
    yield* side.drain();
  } finally {
    side.close();
  }
}
