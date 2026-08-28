import type { AgentObserver, AgentTelemetryEvent } from "@eva/harness";

import type { RunFailureLayer } from "../../db/schema.js";
import { canonicalStringify, sha256Hex } from "./canonical.js";
import type { RunEventInput, RunRecorder } from "./run-recorder.js";

/**
 * T49:run-scoped observer 桥。一个 Run 一个 bridge,主 Agent 与前台子代理的
 * observer 由它分别绑定(agent 不同,recorder 同一个 —— UNIQUE(run_id, seq)
 * 靠共享 recorder 成立)。后台子代理有自己 Run 的 recorder,另起一个 bridge。
 *
 * 身份纪律(契约 3):runId 在 recorder 里,agent 在绑定里,事件本身两样都不带。
 * 没有任何「当前 run」单例。
 *
 * request_snapshot 的同 Run 去重也在这里(§4.3):同一 Run 内部分 hash 全同的
 * 后续 snapshot 只记 request_snapshot_ref 指向首次那条,seq 由 recorder 返回。
 */
export interface ObserverBridgeHooks {
  /** agent_run_end(max-steps)/ agent_run_failed 带的失败层,route settle 时写进 runs。 */
  readonly onFailureLayer?: (layer: RunFailureLayer) => void;
}

export interface ObserverBridge {
  readonly forAgent: (agent: string) => AgentObserver;
}

type SnapshotEvent = Extract<AgentTelemetryEvent, { type: "request_snapshot" }>;

export const createObserverBridge = (
  recorder: RunRecorder,
  hooks: ObserverBridgeHooks = {}
): ObserverBridge => {
  const snapshotSeqByHash = new Map<string, number>();

  const recordSnapshot = (agent: string, event: SnapshotEvent): void => {
    const partHashes = {
      systemPrompt: sha256Hex(event.systemPrompt),
      tools: sha256Hex(canonicalStringify(event.tools)),
      settings: sha256Hex(canonicalStringify(event.callSettings)),
      model: sha256Hex(`${event.provider}:${event.modelId}`)
    };
    const combined = Object.values(partHashes).join("|");
    const seenSeq = snapshotSeqByHash.get(combined);

    if (seenSeq !== undefined) {
      recorder.record({
        agent,
        kind: "request_snapshot_ref",
        payload: { refSeq: seenSeq, partHashes }
      });
      return;
    }

    const seq = recorder.record({
      agent,
      kind: "request_snapshot",
      payload: {
        provider: event.provider,
        modelId: event.modelId,
        callSettings: event.callSettings,
        systemPrompt: event.systemPrompt,
        tools: event.tools,
        partHashes
      }
    });
    if (seq !== undefined) {
      snapshotSeqByHash.set(combined, seq);
    }
  };

  const forAgent = (agent: string): AgentObserver => {
    const record = (kind: RunEventInput["kind"], fields?: Partial<RunEventInput>): void => {
      recorder.record({ agent, kind, ...fields });
    };

    return (event: AgentTelemetryEvent): void => {
      switch (event.type) {
        // agent_run_start 不落 ledger:route 侧的 run_started 更早(台账行建立时),
        // turn_started 更准(loop 起步)。Pino 仍拿它,不落库不算丢。
        case "agent_run_start":
          break;
        case "agent_run_end":
          record("run_completed", {
            durationMs: event.totalDurationMs,
            payload: {
              stepCount: event.stepCount,
              toolCallCount: event.toolCallCount,
              usage: event.totalTokenUsage
            }
          });
          if (event.failureLayer !== undefined) {
            hooks.onFailureLayer?.(event.failureLayer);
          }
          break;
        case "agent_run_failed":
          record("run_failed", {
            severity: "error",
            payload: { error: event.error, failureLayer: event.failureLayer }
          });
          hooks.onFailureLayer?.(event.failureLayer);
          break;
        case "turn_started":
          record("turn_started", { turnIndex: event.turnIndex });
          break;
        case "turn_completed":
          record("turn_completed", {
            turnIndex: event.turnIndex,
            durationMs: event.durationMs,
            payload: { status: event.status }
          });
          break;
        case "step_started":
          record("step_started", { stepIndex: event.step, attempt: event.attempt });
          break;
        case "llm_call_start":
          record("model_call_started", {
            stepIndex: event.step,
            ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
            payload: { model: event.model }
          });
          break;
        case "model_first_token":
          record("model_first_token", {
            stepIndex: event.step,
            attempt: event.attempt,
            durationMs: event.durationMs
          });
          break;
        case "model_call_completed":
          record("model_call_completed", {
            stepIndex: event.step,
            attempt: event.attempt
          });
          break;
        case "model_call_failed":
          record("model_call_failed", {
            stepIndex: event.step,
            attempt: event.attempt,
            severity: "error",
            payload: { error: event.error, willRetry: event.willRetry }
          });
          break;
        case "assistant_message":
          record("assistant_message", {
            payload: { text: event.text, toolCallCount: event.toolCallCount }
          });
          break;
        case "request_snapshot":
          recordSnapshot(agent, event);
          break;
        case "llm_call_end":
          record("step_completed", {
            stepIndex: event.step,
            durationMs: event.durationMs,
            payload: {
              tokenUsage: event.tokenUsage,
              hasToolCalls: event.hasToolCalls
            }
          });
          break;
        case "tool_call_started":
          record("tool_call_started", {
            stepIndex: event.step,
            toolCallId: event.toolCallId,
            payload: { toolName: event.toolName, args: event.input ?? {} }
          });
          break;
        case "tool_call_completed":
          record("tool_call_completed", {
            stepIndex: event.step,
            toolCallId: event.toolCallId,
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            payload: {
              toolName: event.toolName,
              status: event.status,
              ...(event.output !== undefined ? { output: event.output } : {}),
              ...(event.toolExecMs !== undefined ? { toolExecMs: event.toolExecMs } : {}),
              ...(event.approvalWaitMs !== undefined
                ? { approvalWaitMs: event.approvalWaitMs }
                : {}),
              ...(event.queueWaitMs !== undefined ? { queueWaitMs: event.queueWaitMs } : {}),
              ...(event.execAborted !== undefined ? { execAborted: event.execAborted } : {})
            }
          });
          break;
        case "approval_asked":
          record("approval_asked", {
            toolCallId: event.toolCallId,
            payload: { toolName: event.toolName }
          });
          break;
        case "tool_call_abandoned":
          // T51:abort 补发 —— duration_ms 是未分解的墙钟等待,decomposed=false
          // 提醒读端别拿它当 tool_exec_ms 用。
          record("tool_call_abandoned", {
            stepIndex: event.step,
            toolCallId: event.toolCallId,
            severity: "warn",
            durationMs: event.waitedMs,
            payload: { toolName: event.toolName, decomposed: false }
          });
          break;
        case "approval_decided":
          record("approval_decided", {
            toolCallId: event.toolCallId,
            payload: { toolName: event.toolName, approved: event.approved }
          });
          break;
        case "tool_call_repaired":
          record("tool_call_repaired", {
            payload: { toolName: event.toolName, repairKind: event.kind }
          });
          break;
        case "loop_transition":
          record("loop_transition", {
            stepIndex: event.step,
            ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
            payload: { reason: event.reason }
          });
          break;
        case "context_compacted":
          record("context_compacted", {
            stepIndex: event.step,
            payload: {
              reason: event.reason,
              messageCountBefore: event.messageCountBefore,
              messageCountAfter: event.messageCountAfter,
              estimatedTokensBefore: event.estimatedTokensBefore,
              estimatedTokensAfter: event.estimatedTokensAfter
            }
          });
          break;
        case "context_overflow_clamp":
          record("context_overflow", {
            severity: "warn",
            payload: {
              providerId: event.providerId,
              modelId: event.modelId,
              contextWindow: event.contextWindow,
              observedTokens: event.observedTokens
            }
          });
          break;
        case "tool_count_degraded":
          // 装配期警告:Pino 的 warning 已覆盖,ledger 里没有它的 kind(T47 清单外)。
          break;
      }
    };
  };

  return { forAgent };
};

/**
 * 多订阅者扇出。一个订阅者抛错不影响其余 —— ledger 写挂了 Pino 照常,
 * 反之亦然(契约:观测绝不能打挂业务)。
 */
export const fanout = (
  ...observers: readonly (AgentObserver | undefined)[]
): AgentObserver => {
  const active = observers.filter(
    (observer): observer is AgentObserver => observer !== undefined
  );
  return (event) => {
    for (const observer of active) {
      try {
        observer(event);
      } catch {
        // 单个订阅者炸了不拖垮其余
      }
    }
  };
};
