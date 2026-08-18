import { useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type {
  EvaUIMessage,
  RunAgentStreamEvent,
  RunApprovalRequestEvent,
  RunApprovalResolvedEvent
} from "@eva/shared";
import { UiMessageBuilder, createUserUIMessage } from "@eva/shared";

import { abortRun, streamChat } from "../../../shared/api/run-stream-client";
import { apiFetch } from "../../../shared/api/fetch";
import type { ThreadMessage } from "../../../types/api";

export interface UseChatHandlers {
  /** 审批事件(T0.4 引入的 SSE 事件),由 useApprovals 驱动。 */
  readonly onApproval?: (event: RunApprovalRequestEvent | RunApprovalResolvedEvent) => void;
}

interface UseChatReturn {
  /** 已完成的消息(引用只在轮次边界变化)。 */
  readonly messages: readonly EvaUIMessage[];
  /** 在飞的 assistant 消息;null 表示当前没有 run。 */
  readonly streamingMessage: EvaUIMessage | null;
  readonly isStreaming: boolean;
  readonly sessionId: string | null;
  readonly sendMessage: (text: string, modelId?: string) => void;
  readonly stopStreaming: () => void;
  readonly newConversation: () => void;
  readonly loadSession: (threadId: string) => void;
}

export function useChat(handlers: UseChatHandlers = {}): UseChatReturn {
  const queryClient = useQueryClient();
  const [committed, setCommitted] = useState<EvaUIMessage[]>([]);
  const [streaming, setStreaming] = useState<EvaUIMessage | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const builderRef = useRef<UiMessageBuilder | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const sendMessage = useCallback((text: string, modelId?: string) => {
    const trimmed = text.trim();
    if (isStreaming || trimmed.length === 0) {
      return;
    }

    const userMessage = createUserUIMessage(crypto.randomUUID(), trimmed);
    const assistantId = crypto.randomUUID();
    builderRef.current = new UiMessageBuilder(assistantId);

    // 用户消息一次性进 committed;assistant 走 streaming 通道。
    setCommitted((prev) => [...prev, userMessage]);
    setStreaming({ id: assistantId, role: "assistant", parts: [] });
    setIsStreaming(true);
    runIdRef.current = null;

    const onEvent = (event: RunAgentStreamEvent): void => {
      const builder = builderRef.current;
      if (!builder) {
        return;
      }

      builder.push(event);
      // 只换 streaming 这一个引用 —— committed 数组完全不动
      setStreaming(builder.snapshot());
    };

    streamChat(
      {
        text: trimmed,
        sessionId: sessionIdRef.current ?? undefined,
        ...(modelId ? { modelId } : {})
      },
      {
        onRunStart(runId, returnedSessionId) {
          runIdRef.current = runId;
          sessionIdRef.current = returnedSessionId;
          setSessionId(returnedSessionId);
          queryClient.invalidateQueries({ queryKey: ["threads"] });
        },

        onEvent,

        onApproval(event) {
          handlersRef.current.onApproval?.(event);
        },

        onError(message) {
          setStreaming({
            id: assistantId,
            role: "assistant",
            parts: [{ type: "text", text: `Error: ${message}`, state: "done" }]
          });
        },

        onEnd() {
          const builder = builderRef.current;
          // 结算:把最终消息并进 committed,清空 streaming。
          // 顺序:先 setCommitted 再 setStreaming(null)。React 18+ 同事件内批处理,
          // 不会出现"消息短暂消失"的中间态。
          if (builder) {
            const finalMessage = builder.build();
            setCommitted((prev) => [...prev, finalMessage]);
            builderRef.current = null;
          }
          setStreaming(null);
          setIsStreaming(false);
          runIdRef.current = null;

          // run 结束 → 用量与侧栏状态各刷一次(不在流式中途轮询,避免给 SQLite 加压力)。
          const currentSessionId = sessionIdRef.current;
          if (currentSessionId) {
            queryClient.invalidateQueries({ queryKey: ["thread-usage", currentSessionId] });
            queryClient.invalidateQueries({ queryKey: ["threads"] });
          }
        }
      }
    );
  }, [isStreaming]);

  const stopStreaming = useCallback(() => {
    if (!isStreaming || !runIdRef.current) return;
    abortRun(runIdRef.current).catch(() => {});
  }, [isStreaming]);

  const newConversation = useCallback(() => {
    setCommitted([]);
    setStreaming(null);
    sessionIdRef.current = null;
    setSessionId(null);
  }, []);

  const loadSession = useCallback((threadId: string) => {
    if (threadId === sessionIdRef.current) return;

    sessionIdRef.current = threadId;
    setSessionId(threadId);
    setCommitted([]);
    setStreaming(null);

    apiFetch<readonly ThreadMessage[]>(`/api/v1/threads/${threadId}/messages`)
      .then((data) => {
        setCommitted(data.map((m) => m.message));
      })
      .catch(() => {
        // Session not found or error — stay with empty messages
      });
  }, []);

  return {
    messages: committed,
    streamingMessage: streaming,
    isStreaming,
    sessionId,
    sendMessage,
    stopStreaming,
    newConversation,
    loadSession
  };
}