import type { RunStreamEvent, RunStreamFrame, StreamFinishReason } from "@eva/shared";
import { DeltaAccumulator } from "../shared/streaming/delta-accumulator.js";
import type { StreamEvent } from "../shared/streaming/types.js";

export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ToolCallInfo {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args: Record<string, unknown>;
  readonly output?: string;
  readonly status?: "success" | "error";
  readonly durationMs?: number;
}

export interface StreamCallbacks {
  readonly onTextChunk: (content: string) => void;
  readonly onToolCallStart: (info: ToolCallInfo) => void;
  readonly onToolCallEnd: (info: ToolCallInfo) => void;
    readonly onResult: (
    text: string,
    toolCalls: ToolCallInfo[],
    finishReason: StreamFinishReason,
    returnedSessionId?: string
  ) => void;
  readonly onError: (message: string) => void;
  readonly onEnd: () => void;
  readonly onRunStart?: (runId: string, sessionId: string) => void;
}

interface StreamRequest {
  readonly messages: readonly ChatMessage[];
  readonly sessionId?: string;
  readonly modelId?: string;
}

/**
 * Parse SSE lines from a text buffer.
 * Returns [parsedEvents, remainingBuffer].
 */
const parseSSEBuffer = (
  buffer: string
): [Array<{ event: string; data: string }>, string] => {
  const events: Array<{ event: string; data: string }> = [];
  const lines = buffer.split("\n");

  let currentEvent = "";
  let currentData = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7);
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "") {
      if (currentEvent && currentData) {
        events.push({ event: currentEvent, data: currentData });
      }
      currentEvent = "";
      currentData = "";
    }

    i++;
  }

  // Return unparsed remainder (incomplete frame)
  const remainder =
    currentEvent || currentData
      ? lines.slice(Math.max(0, i - 2)).join("\n")
      : "";

  return [events, remainder];
};

const dispatchEvent = (ev: RunStreamEvent, callbacks: StreamCallbacks): void => {
  switch (ev.type) {
    case "text-delta":
      callbacks.onTextChunk(ev.textDelta);
      break;
    case "tool-call":
      callbacks.onToolCallStart({
        toolName: ev.toolName,
        toolCallId: ev.toolCallId,
        args: ev.input ?? {}
      });
      break;
    case "tool-result":
      callbacks.onToolCallEnd({
        toolName: ev.toolName,
        toolCallId: ev.toolCallId,
        args: {},
        output: ev.output,
        status: ev.status,
        ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {})
      });
      break;
    case "finish":
      callbacks.onResult(ev.text, ev.toolCalls ?? [], ev.finishReason);
      break;
    case "run_start":
      callbacks.onRunStart?.(ev.runId, ev.sessionId);
      break;
    default:
      break;
  }
};

export async function streamChat(
  request: StreamRequest,
  callbacks: StreamCallbacks
): Promise<void> {
  const response = await fetch("/api/v1/runs/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const text = await response.text();
    callbacks.onError(`HTTP ${response.status}: ${text}`);
    callbacks.onEnd();
    return;
  }

  const reader = response.body?.getReader();

  if (!reader) {
    callbacks.onError("No response body");
    callbacks.onEnd();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const accumulator = new DeltaAccumulator();

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const [events, remainder] = parseSSEBuffer(buffer);
      buffer = remainder;

      for (const { event, data } of events) {
        try {
          if (event === "end") {
            callbacks.onEnd();
            return;
          }

          if (event === "error") {
            const parsed = JSON.parse(data) as { message: string };
            callbacks.onError(parsed.message);
            continue;
          }

          const parsed = JSON.parse(data) as RunStreamFrame;
          const ready = accumulator.push(parsed as StreamEvent);

          for (const ev of ready) {
            dispatchEvent(ev as unknown as RunStreamEvent, callbacks);
          }
        } catch {
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  callbacks.onEnd();
}

export async function abortRun(runId: string): Promise<void> {
  const response = await fetch(`/api/v1/runs/${runId}/abort`, {
    method: "POST"
  });

  if (response.status === 404) {
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
}
