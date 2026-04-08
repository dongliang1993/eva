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
  readonly onResult: (text: string, toolCalls: ToolCallInfo[], sessionId?: string) => void;
  readonly onError: (message: string) => void;
  readonly onEnd: () => void;
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
  const remainder = currentEvent || currentData
    ? lines.slice(Math.max(0, i - 2)).join("\n")
    : "";

  return [events, remainder];
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
          switch (event) {
            case "text_chunk": {
              const parsed = JSON.parse(data) as { content: string };
              callbacks.onTextChunk(parsed.content);
              break;
            }
            case "tool_call_start": {
              const parsed = JSON.parse(data) as ToolCallInfo;
              callbacks.onToolCallStart(parsed);
              break;
            }
            case "tool_call_end": {
              const parsed = JSON.parse(data) as ToolCallInfo;
              callbacks.onToolCallEnd(parsed);
              break;
            }
            case "result": {
              const parsed = JSON.parse(data) as {
                text: string;
                toolCalls: ToolCallInfo[];
                sessionId?: string;
              };
              callbacks.onResult(parsed.text, parsed.toolCalls, parsed.sessionId);
              break;
            }
            case "error": {
              const parsed = JSON.parse(data) as { message: string };
              callbacks.onError(parsed.message);
              break;
            }
            case "end": {
              callbacks.onEnd();
              return;
            }
          }
        } catch {
          // Skip malformed events
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  callbacks.onEnd();
}
