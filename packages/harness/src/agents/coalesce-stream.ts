import type { AgentStreamEvent } from "./types.js";
import { STREAM_COALESCE_WINDOW_MS } from "../constants.js";

interface Timer {
  promise: Promise<void>;
  clear: () => void;
}

function createTimer(ms: number): Timer {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, ms);
  });
  return {
    promise,
    clear: () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  };
}

export async function* coalesceTextDeltas(
  events: AsyncIterable<AgentStreamEvent>
): AsyncGenerator<AgentStreamEvent> {
  const source = events[Symbol.asyncIterator]();
  let textBuffer: string | undefined;
  let reasoningBuffer: string | undefined;
  let textTimer: Timer | undefined;
  let reasoningTimer: Timer | undefined;

  const flushText = (): AgentStreamEvent | undefined => {
    if (textTimer !== undefined) {
      textTimer.clear();
      textTimer = undefined;
    }
    if (textBuffer === undefined || textBuffer.length === 0) {
      textBuffer = undefined;
      return undefined;
    }
    const event: AgentStreamEvent = { type: "text-delta", textDelta: textBuffer };
    textBuffer = undefined;
    return event;
  };

  const flushReasoning = (): AgentStreamEvent | undefined => {
    if (reasoningTimer !== undefined) {
      reasoningTimer.clear();
      reasoningTimer = undefined;
    }
    if (reasoningBuffer === undefined || reasoningBuffer.length === 0) {
      reasoningBuffer = undefined;
      return undefined;
    }
    const event: AgentStreamEvent = {
      type: "reasoning-delta",
      textDelta: reasoningBuffer
    };
    reasoningBuffer = undefined;
    return event;
  };

  const startTextTimer = (): void => {
    textTimer = createTimer(STREAM_COALESCE_WINDOW_MS);
  };

  const startReasoningTimer = (): void => {
    reasoningTimer = createTimer(STREAM_COALESCE_WINDOW_MS);
  };

  let nextPromise: Promise<IteratorResult<AgentStreamEvent, unknown>> =
    source.next();

  while (true) {
    const race: Array<
      Promise<
        | { kind: "event"; result: IteratorResult<AgentStreamEvent, unknown> }
        | { kind: "timer"; type: "text" | "reasoning" }
      >
    > = [
      nextPromise.then((result) => ({ kind: "event", result }))
    ];

    if (textTimer !== undefined) {
      race.push(
        textTimer.promise.then(() => ({ kind: "timer", type: "text" }))
      );
    }
    if (reasoningTimer !== undefined) {
      race.push(
        reasoningTimer.promise.then(() => ({ kind: "timer", type: "reasoning" }))
      );
    }

    const winner = await Promise.race(race);

    if (winner.kind === "timer") {
      if (winner.type === "text") {
        const flushed = flushText();
        if (flushed !== undefined) {
          yield flushed;
        }
      } else {
        const flushed = flushReasoning();
        if (flushed !== undefined) {
          yield flushed;
        }
      }
      continue;
    }

    const { result } = winner;

    if (result.done) {
      const flushedText = flushText();
      if (flushedText !== undefined) {
        yield flushedText;
      }
      const flushedReasoning = flushReasoning();
      if (flushedReasoning !== undefined) {
        yield flushedReasoning;
      }
      return;
    }

    const event = result.value;

    if (event.type === "text-delta") {
      if (textBuffer === undefined && textTimer === undefined) {
        yield event;
        textBuffer = "";
        startTextTimer();
      } else {
        textBuffer = (textBuffer ?? "") + event.textDelta;
      }
      nextPromise = source.next();
      continue;
    }

    if (event.type === "reasoning-delta") {
      if (reasoningBuffer === undefined && reasoningTimer === undefined) {
        yield event;
        reasoningBuffer = "";
        startReasoningTimer();
      } else {
        reasoningBuffer = (reasoningBuffer ?? "") + event.textDelta;
      }
      nextPromise = source.next();
      continue;
    }

    const flushedText = flushText();
    if (flushedText !== undefined) {
      yield flushedText;
    }
    const flushedReasoning = flushReasoning();
    if (flushedReasoning !== undefined) {
      yield flushedReasoning;
    }

    yield event;
    nextPromise = source.next();
  }
}
