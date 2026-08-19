import type {
  EvaDynamicToolPart,
  RunAgentStreamEvent,
  RunApprovalRequestEvent,
  RunApprovalResolvedEvent,
  RunStreamEvent,
  RunStreamFrame,
  RunSubagentUpdateEvent,
  RunSubagentReportEvent,
  StreamFinishReason
} from "@eva/shared";
import { toolPartOutput } from "@eva/shared";
import { DeltaAccumulator } from "../streaming/delta-accumulator.js";
import type { StreamEvent } from "../streaming/types.js";

export interface ToolCallInfo {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args: Record<string, unknown>;
  readonly output?: string;
  readonly status?: "success" | "error";
  readonly durationMs?: number;
}

export interface StreamCallbacks {
  readonly onRunStart?: (runId: string, sessionId: string) => void;
  /** 已按 seq 归位的 agent 事件,交给 SSE 累积。 */
  readonly onEvent: (event: RunAgentStreamEvent) => void;
  /** T0.4 引入的 Eva 自有域审批事件。 */
  readonly onApproval?: (event: RunApprovalRequestEvent | RunApprovalResolvedEvent) => void;
  /** S7:子代理事件。与主链隔离 —— 走专属 callback,绝不并进 onEvent 的主 builder。 */
  readonly onSubagent?: (event: RunSubagentUpdateEvent) => void;
  /** S7:子代理主动交付了结论 —— 卡片即时显示"已回报"。 */
  readonly onSubagentReport?: (event: RunSubagentReportEvent) => void;
  readonly onError: (message: string) => void;
  readonly onEnd: (finishReason: StreamFinishReason) => void;
}

export interface StreamRequest {
  /** 新消息。与 retryMessageId 二选一;retry 模式不传。 */
  readonly text?: string;
  readonly sessionId?: string;
  readonly modelId?: string;
  /** 重新生成这条 assistant 消息(同槽位落新版本)。必须同时给 sessionId。 */
  readonly retryMessageId?: string;
}

/**
 * 把 dynamic-tool part 派生成 ToolCallInfo —— 这样 tool-call-block.tsx 不用动。
 * T3 会把 tool-call-block 改成直接消费 part,届时本适配器移除。
 */
export const toolPartToInfo = (part: EvaDynamicToolPart): ToolCallInfo => ({
  toolName: part.toolName,
  toolCallId: part.toolCallId,
  args: (part.input as Record<string, unknown>) ?? {},
  ...(part.state === "output-available" || part.state === "output-error"
    ? {
      output: toolPartOutput(part),
      status: part.state === "output-error" ? ("error" as const) : ("success" as const)
    }
    : {}),
  ...(typeof part.toolMetadata?.durationMs === "number"
    ? { durationMs: part.toolMetadata.durationMs }
    : {})
});

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
    case "run_start":
      callbacks.onRunStart?.(ev.runId, ev.sessionId);
      break;
    // T0.4 引入的审批事件:T3 接进 useApprovals。
    case "approval_request":
    case "approval_resolved":
      callbacks.onApproval?.(ev);
      break;
    // S7:子代理事件与主链隔离段 —— 🔴 若漏掉这个 case,会掉进 default 被并进主
    // builder,子代理的中间过程反向污染主上下文(T15 §2.4 的静默失败模式)。
    case "subagent_update":
      callbacks.onSubagent?.(ev);
      break;
    case "subagent_report":
      callbacks.onSubagentReport?.(ev);
      break;
    case "end":
      callbacks.onEnd(ev.finishReason);
      break;
    case "error":
      callbacks.onError(ev.message);
      break;
    default:
      // 其余都是 agent 域事件(text-delta / tool-* / step-start / finish),
      // 按 seq 归位后整条交给 UiMessageBuilder。
      callbacks.onEvent(ev as RunAgentStreamEvent);
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
    callbacks.onEnd("error");
    return;
  }

  const reader = response.body?.getReader();

  if (!reader) {
    callbacks.onError("No response body");
    callbacks.onEnd("error");
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
            const parsed = JSON.parse(data) as { finishReason: StreamFinishReason };
            callbacks.onEnd(parsed.finishReason);
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
          // 忽略单帧解析失败,不要因为一个坏帧断掉整个流
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  callbacks.onEnd("stop");
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