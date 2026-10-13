import type { ModelMessage } from "ai";
import type { HarnessMessage as Message } from "@eva/harness";
import type { RunStreamEvent } from "@eva/shared";

/**
 * HarnessMessage → 现有 SSE 帧（plan §3.5 的映射表）。
 *
 * 纯函数、穷尽 switch：SSE 协议不动，前端零改动。
 * stream-reducer / run-detach / run-lifecycle 的测试钉的就是这层映射 ——
 * 顺序保证(system/init → [step_start → … → assistant → turn_complete → user] → result)
 * 由 query/turn.ts 产出,harness-frames 只做逐帧翻译。
 *
 * | HarnessMessage            | 帧 |
 * |---------------------------|----|
 * | stream_event step_start   | step-start(step = turn;先于本次调用其它帧) |
 * | stream_event text/reasoning/tool_input_* | text-delta / reasoning-delta / tool-input-start / tool-input-delta |
 * | assistant(tool-call part) | tool-call 帧 |
 * | assistant(text/reasoning) | 无(增量已由 stream_event 发过) |
 * | system/turn_complete      | 无 |
 * | user                      | 每个 tool-result part → tool-result 帧(status 由 isError,计时取 tool_timing) |
 * | result success / error_max_turns / interrupted | finish 帧 |
 * | result error_during_execution | error 帧(带 failureLayer)+ finish(error) |
 * | system/init / compact_boundary | 无 |
 */
export const toRunStreamFrames = (
  message: Message,
): readonly RunStreamEvent[] => {
  switch (message.type) {
    case "system":
      // init / turn_complete / compact_boundary 的信息走轨迹页(run_events),不进 SSE。
      return [];

    case "stream_event":
      return streamEventFrames(message);

    case "assistant":
      // 文本/推理块的增量已由 stream_event 发过;这里只翻 tool-call 块。
      return toolCallFrames(message.message.content);

    case "user":
      return toolResultFrames(message);

    case "result":
      return resultFrames(message);
    default: {
      // 穷尽 switch:新增 HarnessMessage 变体在编译期就该报错,不该静默丢帧。
      const unreachable: never = message;
      return unreachable;
    }
  }
};

const streamEventFrames = (
  message: Extract<Message, { type: "stream_event" }>,
): readonly RunStreamEvent[] => {
  switch (message.event.type) {
    case "step_start":
      return [{ type: "step-start", step: message.event.turn }];
    case "text_delta":
      return [{ type: "text-delta", textDelta: message.event.text }];
    case "reasoning_delta":
      return [{ type: "reasoning-delta", textDelta: message.event.text }];
    case "tool_input_start":
      return [{
        type: "tool-input-start",
        toolCallId: message.event.tool_use_id,
        toolName: message.event.tool_name,
      }];
    case "tool_input_delta":
      return [{
        type: "tool-input-delta",
        toolCallId: message.event.tool_use_id,
        delta: message.event.delta,
      }];
    default: {
      const unreachable: never = message.event;
      return unreachable;
    }
  }
};

const toolCallFrames = (
  content: Extract<ModelMessage, { role: "assistant" }>["content"],
): readonly RunStreamEvent[] => {
  if (typeof content === "string") return [];
  const frames: RunStreamEvent[] = [];
  for (const part of content) {
    if (part.type === "tool-call") {
      frames.push({
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: (part.input as Record<string, unknown>) ?? {},
      });
    }
  }
  return frames;
};

const toolResultFrames = (
  message: Extract<Message, { type: "user" }>,
): readonly RunStreamEvent[] => {
  const timingOf = (id: string) => message.tool_timing[id];
  const frames: RunStreamEvent[] = [];
  if (typeof message.message.content !== "string") {
    for (const part of message.message.content) {
      if (part.type !== "tool-result") continue;
      const output = part.output;
      // output 是 ToolResultOutput:text 分支是 toModelOutput(textOf) 的产物。
      const outputText =
        output.type === "text" && typeof output.value === "string"
          ? output.value
          : JSON.stringify((output as { value?: unknown }).value ?? null);
      const timing = timingOf(part.toolCallId);
      frames.push({
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: outputText,
        // isError 不在 AI SDK 的 part 上:Error: 前缀是 runToolCall 的 errorResult 拼的
        // (与 turn.ts 的收集同一通道);aborted() 也带前缀,abort 补发同样命中。
        status: outputText.startsWith("Error:") ? "error" : "success",
        ...(timing !== undefined
          ? {
              toolExecMs: timing.exec_ms,
              approvalWaitMs: timing.approval_wait_ms,
              queueWaitMs: timing.queue_wait_ms,
              // abort 补发:durationMs 是未分解墙钟(等三段之和),历史徽章的兼容字段。
              ...(timing.aborted
                ? {
                    durationMs:
                      timing.approval_wait_ms + timing.queue_wait_ms + timing.exec_ms,
                  }
                : {}),
            }
          : {}),
      });
    }
  }
  return frames;
};

const resultFrames = (
  message: Extract<Message, { type: "result" }>,
): readonly RunStreamEvent[] => {
  const usage =
    message.usage.input_tokens > 0 || message.usage.output_tokens > 0
      ? {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          totalTokens:
            message.usage.input_tokens + message.usage.output_tokens,
          ...(message.usage.cache_read_input_tokens !== undefined
            ? { cachedInputTokens: message.usage.cache_read_input_tokens }
            : {}),
          ...(message.usage.cache_creation_input_tokens !== undefined
            ? { cacheWriteTokens: message.usage.cache_creation_input_tokens }
            : {}),
          ...(message.usage.reasoning_tokens !== undefined
            ? { reasoningTokens: message.usage.reasoning_tokens }
            : {}),
        }
      : undefined;

  if (message.subtype === "success") {
    return [{
      type: "finish",
      text: message.result,
      toolCalls: [],
      finishReason: "stop",
      ...(usage !== undefined ? { usage } : {}),
      durationMs: message.duration_ms,
    }];
  }

  if (message.subtype === "interrupted" || message.subtype === "error_max_turns") {
    // 文案进 finish.text(与旧 finishRun 一致):max-steps 带步数与续跑路径,interrupted 带已产出文本。
    const [firstError] = message.errors;
    return [{
      type: "finish",
      text: firstError ?? "",
      toolCalls: [],
      finishReason: message.subtype === "interrupted" ? "aborted" : "max-steps",
      ...(usage !== undefined ? { usage } : {}),
      durationMs: message.duration_ms,
    }];
  }

  // error_during_execution:只发 error 帧(与旧行为一致 —— error 之后 SSE 直接 end,
  // 不再补 finish;recorder 的 finishReason 由 error 帧置位)。
  const [firstError] = message.errors;
  return [
    {
      type: "error",
      message: firstError ?? "Agent stream ended without a terminal outcome",
      ...(message.failure_layer !== undefined
        ? { failureLayer: message.failure_layer }
        : {}),
    },
  ];
};
