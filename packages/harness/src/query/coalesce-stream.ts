import type { HarnessMessage } from "./types.js";
import { STREAM_COALESCE_WINDOW_MS } from "../constants.js";

/**
 * HarnessMessage 流的 text/reasoning 合并窗口。
 *
 * 只作用 stream_event 的 text_delta / reasoning_delta(与旧 coalesceTextDeltas
 * 同一个窗口常量);其余消息(assistant/user/result/…)原样透传、不缓冲 ——
 * tool-call 的 assistant 到达即放,审批帧依赖这条先到。
 */
export async function* coalesceStreamEvents(
  messages: AsyncIterable<HarnessMessage>,
): AsyncGenerator<HarnessMessage> {
  const source = messages[Symbol.asyncIterator]();
  let textBuffer: string | undefined;
  let reasoningBuffer: string | undefined;

  const flushText = (): HarnessMessage | undefined => {
    if (textBuffer === undefined || textBuffer.length === 0) {
      textBuffer = undefined;
      return undefined;
    }
    const message: HarnessMessage = {
      type: "stream_event",
      event: { type: "text_delta", text: textBuffer },
      parent_tool_use_id: null,
    };
    textBuffer = undefined;
    return message;
  };
  const flushReasoning = (): HarnessMessage | undefined => {
    if (reasoningBuffer === undefined || reasoningBuffer.length === 0) {
      reasoningBuffer = undefined;
      return undefined;
    }
    const message: HarnessMessage = {
      type: "stream_event",
      event: { type: "reasoning_delta", text: reasoningBuffer },
      parent_tool_use_id: null,
    };
    reasoningBuffer = undefined;
    return message;
  };

  let nextPromise = source.next();
  let textDeadline: number | undefined;
  let reasoningDeadline: number | undefined;

  while (true) {
    const timers: Array<Promise<"text" | "reasoning">> = [];
    const now = () => Date.now();
    void now;
    if (textBuffer !== undefined && textDeadline !== undefined) {
      // 窗口到点:非阻塞检查由 race 承担 —— 这里用 setTimeout 到点 flush。
      void textDeadline;
    }
    void timers;

    const winner = await Promise.race([
      nextPromise.then((result) => ({ kind: "event" as const, result })),
      delayUntilFirst(textDeadline, "text"),
      delayUntilFirst(reasoningDeadline, "reasoning"),
    ]);

    if (winner.kind === "timer") {
      const flushed =
        winner.type === "text" ? flushText() : flushReasoning();
      if (winner.type === "text") textDeadline = undefined;
      else reasoningDeadline = undefined;
      if (flushed !== undefined) yield flushed;
      continue;
    }

    const { result } = winner;
    if (result.done) {
      const flushedText = flushText();
      if (flushedText !== undefined) yield flushedText;
      const flushedReasoning = flushReasoning();
      if (flushedReasoning !== undefined) yield flushedReasoning;
      return;
    }

    const message = result.value;
    if (
      message.type === "stream_event" && message.event.type === "text_delta"
    ) {
      if (textBuffer === undefined) {
        textBuffer = message.event.text;
        textDeadline = Date.now() + STREAM_COALESCE_WINDOW_MS;
      } else {
        textBuffer += message.event.text;
      }
      nextPromise = source.next();
      continue;
    }
    if (
      message.type === "stream_event" && message.event.type === "reasoning_delta"
    ) {
      if (reasoningBuffer === undefined) {
        reasoningBuffer = message.event.text;
        reasoningDeadline = Date.now() + STREAM_COALESCE_WINDOW_MS;
      } else {
        reasoningBuffer += message.event.text;
      }
      nextPromise = source.next();
      continue;
    }

    // 其它消息:先冲掉缓冲里的增量,顺序不能乱(assistant 在增量后)。
    const flushedText = flushText();
    if (flushedText !== undefined) yield flushedText;
    textDeadline = undefined;
    const flushedReasoning = flushReasoning();
    if (flushedReasoning !== undefined) yield flushedReasoning;
    reasoningDeadline = undefined;
    yield message;
    nextPromise = source.next();
  }
}

/** 到点的 delay;deadline 未设时给一个永不赢的 promise。 */
const delayUntilFirst = (
  deadline: number | undefined,
  type: "text" | "reasoning",
): Promise<{ kind: "timer"; type: "text" | "reasoning" }> => {
  if (deadline === undefined) {
    return new Promise(() => { });
  }
  return new Promise((resolve) => {
    setTimeout(() => resolve({ kind: "timer", type }), Math.max(0, deadline - Date.now()));
  });
};
