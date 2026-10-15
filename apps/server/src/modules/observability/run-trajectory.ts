import { isErrorOutput, toolOutputText } from "@eva/harness";
import type { HarnessMessage } from "@eva/harness";

import { canonicalStringify, sha256Hex } from "./canonical.js";
import type { RunRecorder } from "./run-recorder.js";

/**
 * HarnessMessage → run_events(轨迹页的 26 种 kind)。
 *
 * 替代 observer-bridge 的 switch:输入从「fire-and-forget 事件」变成
 * 「query() 产出的消息流」,顺序由契约保证 —— 每条消息在这里只翻一次。
 * request_snapshot 的同 Run 去重照搬(§4.3):全同 hash 的后续 snapshot
 * 只记 request_snapshot_ref 指向首次那条。
 *
 * approval_asked / approval_decided 不在这里 —— 它们由 run-permissions
 * 直接写(它本来就知道,这是唯一能同时看到问与答的地方)。
 * run_started / routing_resolved 由 coordinator 写(装配期)。
 */
export interface RunTrajectory {
  record(message: HarnessMessage): void;
}

/** request_snapshot 需要装配期上下文(query() 的 system/init 只带 messages 域)。 */
export interface TrajectoryRequestContext {
  readonly provider: string;
  readonly modelId: string;
  readonly callSettings: Record<string, unknown>;
}

export const createRunTrajectory = (
  recorder: RunRecorder,
  request: TrajectoryRequestContext,
): RunTrajectory => {
  const snapshotSeqByHash = new Map<string, number>();

  const recordSnapshot = (message: Extract<HarnessMessage, {
    type: "system"; subtype: "init";
  }>): void => {
    const partHashes = {
      systemPrompt: sha256Hex(message.system_prompt),
      tools: sha256Hex(canonicalStringify(
        message.tools.map((name) => ({ name, description: "" })),
      )),
      settings: sha256Hex(canonicalStringify(request.callSettings)),
      model: sha256Hex(`${request.provider}:${request.modelId}`),
    };
    const combined = Object.values(partHashes).join("|");
    const seenSeq = snapshotSeqByHash.get(combined);

    if (seenSeq !== undefined) {
      recorder.record({
        agent: "main",
        kind: "request_snapshot_ref",
        payload: { refSeq: seenSeq, partHashes },
      });
      return;
    }

    const seq = recorder.record({
      agent: "main",
      kind: "request_snapshot",
      payload: {
        provider: request.provider,
        modelId: request.modelId,
        callSettings: request.callSettings,
        systemPrompt: message.system_prompt,
        tools: message.tools.map((name) => ({ name, description: "" })),
        partHashes,
      },
    });
    if (seq !== undefined) {
      snapshotSeqByHash.set(combined, seq);
    }
  };

  return {
    record: (message: HarnessMessage): void => {
      switch (message.type) {
        case "system":
          return systemMessages(recorder, message, recordSnapshot);
        case "stream_event":
          return streamEventMessages(recorder, message);
        case "assistant":
          return assistantMessages(recorder, message);
        case "user":
          return userMessages(recorder, message);
        case "result":
          return resultMessages(recorder, message);
        default: {
          // 穷尽 switch:新增 HarnessMessage 变体在编译期就该报错。
          const unreachable: never = message;
          return unreachable;
        }
      }
    },
  };
};

/** system/init → turn_started + request_snapshot;turn_complete → 模型域事件。 */
const systemMessages = (
  recorder: RunRecorder,
  message: Extract<HarnessMessage, { type: "system" }>,
  recordSnapshot: (m: Extract<HarnessMessage, { type: "system"; subtype: "init" }>) => void,
): void => {
  switch (message.subtype) {
    case "init":
      recorder.record({ agent: "main", kind: "turn_started", turnIndex: 0 });
      recordSnapshot(message);
      return;
    case "turn_complete":
      // model_first_token 的时点信息在消息里(ttft_ms);null 时不记。
      if (message.ttft_ms !== null) {
        recorder.record({
          agent: "main",
          kind: "model_first_token",
          stepIndex: message.turn,
          durationMs: message.ttft_ms,
        });
      }
      recorder.record({
        agent: "main",
        kind: "model_call_completed",
        stepIndex: message.turn,
      });
      recorder.record({
        agent: "main",
        kind: "step_completed",
        stepIndex: message.turn,
        durationMs: message.duration_ms,
        payload: {
          tokenUsage: {
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
          },
          hasToolCalls: message.stop_reason === "tool-calls",
        },
      });
      return;
    case "compact_boundary":
      recorder.record({
        agent: "main",
        kind: "context_compacted",
        payload: {
          reason: message.trigger === "auto" ? "proactive_loop_compact" : "reactive_compact_retry",
          messageCountBefore: message.pre_messages,
          messageCountAfter: message.post_messages,
          estimatedTokensBefore: message.pre_tokens,
          estimatedTokensAfter: message.post_tokens,
        },
      });
      // loop_transition 与 compact 同源:overflow_retry 是「重跑同一 step」的回环。
      if (message.trigger === "overflow_retry") {
        recorder.record({
          agent: "main",
          kind: "loop_transition",
          payload: { reason: "reactive_compact_retry" },
        });
      }
      return;
    default: {
      const unreachable: never = message;
      return unreachable;
    }
  }
};

/** stream_event 只翻 step_start(step_started / model_call_started)。 */
const streamEventMessages = (
  recorder: RunRecorder,
  message: Extract<HarnessMessage, { type: "stream_event" }>,
): void => {
  if (message.event.type !== "step_start") return;
  recorder.record({
    agent: "main",
    kind: "step_started",
    stepIndex: message.event.turn,
    attempt: 1,
  });
  recorder.record({
    agent: "main",
    kind: "model_call_started",
    stepIndex: message.event.turn,
    attempt: 1,
  });
  return;
};

/** assistant 只翻 tool-call 块(tool_call_started;文本块无事件)。 */
const assistantMessages = (
  recorder: RunRecorder,
  message: Extract<HarnessMessage, { type: "assistant" }>,
): void => {
  const content = message.message.content;
  if (typeof content === "string") return;
  for (const part of content) {
    if (part.type !== "tool-call") continue;
    recorder.record({
      agent: "main",
      kind: "tool_call_started",
      stepIndex: message.turn,
      toolCallId: part.toolCallId,
      payload: {
        toolName: part.toolName,
        args: (part.input as Record<string, unknown>) ?? {},
      },
    });
  }
};

/** user:每个 tool-result part → tool_call_completed;timing.aborted → abandoned。 */
const userMessages = (
  recorder: RunRecorder,
  message: Extract<HarnessMessage, { type: "user" }>,
): void => {
  if (typeof message.message.content === "string") return;
  for (const part of message.message.content) {
    if (part.type !== "tool-result") continue;
    const timing = message.tool_timing[part.toolCallId];
    const outputText = toolOutputText(part.output);
    if (timing?.aborted) {
      // abort 补发:duration_ms 是未分解墙钟(三段之和),decomposed=false。
      recorder.record({
        agent: "main",
        kind: "tool_call_abandoned",
        stepIndex: message.turn,
        toolCallId: part.toolCallId,
        severity: "warn",
        durationMs:
          timing.approval_wait_ms + timing.queue_wait_ms + timing.exec_ms,
        payload: {
          toolName: part.toolName,
          decomposed: false,
        },
      });
      continue;
    }
    recorder.record({
      agent: "main",
      kind: "tool_call_completed",
      stepIndex: message.turn,
      toolCallId: part.toolCallId,
      ...(timing !== undefined ? { durationMs: timing.exec_ms } : {}),
      payload: {
        toolName: part.toolName,
        status: isErrorOutput(part.output) ? "error" : "success",
        output: outputText,
        ...(timing !== undefined
          ? {
            toolExecMs: timing.exec_ms,
            approvalWaitMs: timing.approval_wait_ms,
            queueWaitMs: timing.queue_wait_ms,
            execAborted: timing.aborted,
          }
          : {}),
      },
    });
  }
};

/** result:assistant_message / run_completed / run_failed / model_call_failed。 */
const resultMessages = (
  recorder: RunRecorder,
  message: Extract<HarnessMessage, { type: "result" }>,
): void => {
  if (message.subtype === "success") {
    recorder.record({
      agent: "main",
      kind: "assistant_message",
      payload: { text: message.result, toolCallCount: 0 },
    });
    recorder.record({
      agent: "main",
      kind: "turn_completed",
      turnIndex: 0,
      payload: { status: "completed" },
    });
    recorder.record({
      agent: "main",
      kind: "run_completed",
      durationMs: message.duration_ms,
      payload: {
        stepCount: message.num_turns,
        toolCallCount: 0,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          totalTokens:
            message.usage.input_tokens + message.usage.output_tokens,
        },
      },
    });
    return;
  }

  if (message.subtype === "interrupted") {
    recorder.record({
      agent: "main",
      kind: "turn_completed",
      turnIndex: 0,
      payload: { status: "aborted" },
    });
    recorder.record({
      agent: "main",
      kind: "run_completed",
      durationMs: message.duration_ms,
      payload: {
        stepCount: message.num_turns,
        toolCallCount: 0,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          totalTokens:
            message.usage.input_tokens + message.usage.output_tokens,
        },
      },
    });
    return;
  }

  if (message.subtype === "error_max_turns") {
    recorder.record({
      agent: "main",
      kind: "loop_transition",
      stepIndex: message.num_turns,
      payload: { reason: "max_steps" },
    });
    recorder.record({
      agent: "main",
      kind: "assistant_message",
      payload: { text: message.errors[0] ?? "", toolCallCount: 0 },
    });
    recorder.record({
      agent: "main",
      kind: "turn_completed",
      turnIndex: 0,
      payload: { status: "aborted" },
    });
    // max-steps 撞顶是 orchestration 层失败;正常 stop 不带。
    recorder.record({
      agent: "main",
      kind: "run_completed",
      durationMs: message.duration_ms,
      severity: "warn",
      payload: {
        stepCount: message.num_turns,
        toolCallCount: 0,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          totalTokens:
            message.usage.input_tokens + message.usage.output_tokens,
        },
      },
    });
    return;
  }

  // error_during_execution:model_call_failed(带 failure_layer)+ run_failed。
  // context_overflow 的压缩行不在这里 —— 真实 reactive compact 的数字在
  // compact_boundary(trigger=overflow_retry),它先于 result 到达。
  const [firstError] = message.errors;
  recorder.record({
    agent: "main",
    kind: "model_call_failed",
    stepIndex: message.num_turns,
    severity: "error",
    payload: {
      error: firstError ?? "Unknown error",
      willRetry: false,
      ...(message.failure_layer !== undefined
        ? { failureLayer: message.failure_layer }
        : {}),
    },
  });
  recorder.record({
    agent: "main",
    kind: "turn_completed",
    turnIndex: 0,
    payload: { status: "error" },
    severity: "error",
  });
  recorder.record({
    agent: "main",
    kind: "run_failed",
    severity: "error",
    payload: {
      error: firstError ?? "Unknown error",
      failureLayer: message.failure_layer ?? "model",
    },
  });
};
