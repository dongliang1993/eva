import { useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { EvaUIMessage, RunAgentStreamEvent } from "@eva/shared";
import { UiMessageBuilder, createUserUIMessage } from "@eva/shared";

import { abortRun, streamChat } from "../api/client";
import { apiFetch } from "../api/fetch";
import type { ThreadMessage } from "../types/api";

interface UseChatReturn {
  readonly messages: readonly EvaUIMessage[];
  readonly isStreaming: boolean;
  readonly sessionId: string | null;
  readonly sendMessage: (text: string, modelId?: string) => void;
  readonly stopStreaming: () => void;
  readonly newConversation: () => void;
  readonly loadSession: (threadId: string) => void;
}

export function useChat(): UseChatReturn {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<EvaUIMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const builderRef = useRef<UiMessageBuilder | null>(null);
  const assistantIdRef = useRef<string>("");

  const sendMessage = useCallback((text: string, modelId?: string) => {
    const trimmed = text.trim();
    if (isStreaming || trimmed.length === 0) {
      return;
    }

    const userMessage = createUserUIMessage(crypto.randomUUID(), trimmed);
    const assistantId = crypto.randomUUID();
    assistantIdRef.current = assistantId;
    builderRef.current = new UiMessageBuilder(assistantId);

    setMessages((prev) => [
      ...prev,
      userMessage,
      { id: assistantId, role: "assistant", parts: [] }
    ]);
    setIsStreaming(true);
    runIdRef.current = null;

    const onEvent = (event: RunAgentStreamEvent): void => {
      const builder = builderRef.current;
      if (!builder) {
        return;
      }

      builder.push(event);

      // 只换在飞那一条的引用 —— 已完成消息的数组引用完全不动。
      // (T1 仍是全量重建数组,T3 §3.2 会把高频更新隔离到单独的 streaming state)
      const snapshot = builder.snapshot();
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? snapshot : m)));
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

        onError(message) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                  ...m,
                  parts: [{ type: "text", text: `Error: ${message}`, state: "done" }]
                }
                : m
            )
          );
        },

        onEnd() {
          const builder = builderRef.current;
          // 结算:把最终消息并进 messages,清空 builder。
          // (T3 会把 streaming 拆成独立 state,这里先保持单数组。)
          if (builder) {
            const finalMessage = builder.build();
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? finalMessage : m)));
            builderRef.current = null;
          }
          setIsStreaming(false);
          runIdRef.current = null;
        }
      }
    );
  }, [isStreaming]);

  const stopStreaming = useCallback(() => {
    if (!isStreaming || !runIdRef.current) return;
    abortRun(runIdRef.current).catch(() => {});
  }, [isStreaming]);

  const newConversation = useCallback(() => {
    setMessages([]);
    sessionIdRef.current = null;
    setSessionId(null);
  }, []);

  const loadSession = useCallback((threadId: string) => {
    if (threadId === sessionIdRef.current) return;

    sessionIdRef.current = threadId;
    setSessionId(threadId);
    setMessages([]);

    apiFetch<readonly ThreadMessage[]>(`/api/v1/threads/${threadId}/messages`)
      .then((data) => {
        setMessages(data.map((m) => m.message));
      })
      .catch(() => {
        // Session not found or error — stay with empty messages
      });
  }, []);

  return { messages, isStreaming, sessionId, sendMessage, stopStreaming, newConversation, loadSession };
}