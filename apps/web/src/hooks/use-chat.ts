import { useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { StreamFinishReason } from "@eva/shared";
import {
  streamChat,
  abortRun,
  type ChatMessage,
  type ToolCallInfo
} from "../api/client";
import { apiFetch } from "../api/fetch";
import type { ThreadMessage } from "../types/api";

export interface DisplayMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly toolCalls?: readonly ToolCallInfo[];
  readonly isStreaming?: boolean;
  readonly thinkingDurationMs?: number;
}

/**
 * Parse stored message content.
 * Assistant messages may be JSON array of content blocks or plain text.
 */
function parseStoredContent(
  content: string,
  role: "user" | "assistant"
): { text: string; toolCalls: ToolCallInfo[]; thinkingDurationMs?: number } {
  if (role === "user") {
    return { text: content, toolCalls: [] };
  }

  try {
    const parsed: unknown = JSON.parse(content);

    if (!Array.isArray(parsed)) {
      return { text: content, toolCalls: [] };
    }

    const blocks = parsed as Array<{ type: string; [key: string]: unknown }>;
    const toolCalls: ToolCallInfo[] = [];
    const textParts: string[] = [];
    let thinkingDurationMs: number | undefined;

    for (const block of blocks) {
      switch (block.type) {
        case "thinking":
          thinkingDurationMs = typeof block.durationMs === "number" ? block.durationMs : undefined;
          break;
        case "text":
          textParts.push(String(block.text ?? ""));
          break;
        case "tool_use":
          toolCalls.push({
            toolName: String(block.toolName ?? ""),
            toolCallId: String(block.toolCallId ?? ""),
            args: (block.args as Record<string, unknown>) ?? {}
          });
          break;
        case "tool_result":
          // Update the matching tool call with output + duration
          {
            const duration = typeof block.durationMs === "number" ? block.durationMs : undefined;
            const existing = toolCalls.find(
              (tc) => tc.toolCallId === String(block.toolCallId ?? "")
            );
            if (existing) {
              const idx = toolCalls.indexOf(existing);
              toolCalls[idx] = {
                ...existing,
                output: String(block.output ?? ""),
                status: (block.status as "success" | "error") ?? "success",
                ...(duration !== undefined ? { durationMs: duration } : {})
              };
            } else {
              toolCalls.push({
                toolName: String(block.toolName ?? ""),
                toolCallId: String(block.toolCallId ?? ""),
                args: {},
                output: String(block.output ?? ""),
                status: (block.status as "success" | "error") ?? "success",
                ...(duration !== undefined ? { durationMs: duration } : {})
              });
            }
          }
          break;
      }
    }

    return {
      text: textParts.join("\n"),
      toolCalls,
      ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {})
    };
  } catch {
    return { text: content, toolCalls: [] };
  }
}

interface UseChatReturn {
  readonly messages: readonly DisplayMessage[];
  readonly isStreaming: boolean;
  readonly sessionId: string | null;
  readonly sendMessage: (text: string, modelId?: string) => void;
  readonly stopStreaming: () => void;
  readonly newConversation: () => void;
  readonly loadSession: (threadId: string) => void;
}

let nextId = 0;
const genId = (): string => `msg-${++nextId}`;

export function useChat(): UseChatReturn {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const streamingContentRef = useRef("");
  const toolCallsRef = useRef<ToolCallInfo[]>([]);

  const sendMessage = useCallback((text: string, modelId?: string) => {
    if (isStreaming || !text.trim()) return;

    const userMsg: DisplayMessage = {
      id: genId(),
      role: "user",
      content: text.trim()
    };

    const assistantId = genId();

    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", content: "", isStreaming: true }
    ]);
    setIsStreaming(true);
    streamingContentRef.current = "";
    toolCallsRef.current = [];
    runIdRef.current = null;

    const thinkingStartTime = Date.now();
    let thinkingResolved = false;

    const resolveThinking = (): number | undefined => {
      if (thinkingResolved) return undefined;
      thinkingResolved = true;
      return Date.now() - thinkingStartTime;
    };

    const chatMessages: ChatMessage[] = [
      { role: "user", content: text.trim() }
    ];

    streamChat(
      {
        messages: chatMessages,
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

        onTextChunk(content) {
          streamingContentRef.current += content;
          const snapshot = streamingContentRef.current;
          const duration = resolveThinking();

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: snapshot,
                    ...(duration !== undefined ? { thinkingDurationMs: duration } : {})
                  }
                : m
            )
          );
        },

        onToolCallStart(info) {
          toolCallsRef.current = [...toolCallsRef.current, info];

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, toolCalls: [...toolCallsRef.current] }
                : m
            )
          );
        },

        onToolCallEnd(info) {
          toolCallsRef.current = toolCallsRef.current.map((tc) =>
            tc.toolCallId === info.toolCallId
              ? { ...tc, output: info.output, status: info.status }
              : tc
          );

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, toolCalls: [...toolCallsRef.current] }
                : m
            )
          );
        },

        onResult(
          text: string,
          toolCalls: ToolCallInfo[],
          _finishReason: StreamFinishReason,
          returnedSessionId?: string
        ) {
          if (returnedSessionId) {
            sessionIdRef.current = returnedSessionId;
            setSessionId(returnedSessionId);
            queryClient.invalidateQueries({ queryKey: ["threads"] });
          }

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: text,
                    toolCalls: toolCalls.length > 0 ? toolCalls : m.toolCalls,
                    isStreaming: false
                  }
                : m
            )
          );
        },

        onError(message) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `Error: ${message}`, isStreaming: false }
                : m
            )
          );
        },

        onEnd() {
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
        const loaded: DisplayMessage[] = data.map((m) => {
          const { text, toolCalls, thinkingDurationMs } = parseStoredContent(m.content, m.role);

          return {
            id: m.id,
            role: m.role,
            content: text,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
            ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {})
          };
        });
        setMessages(loaded);
      })
      .catch(() => {
        // Session not found or error — stay with empty messages
      });
  }, []);

  return { messages, isStreaming, sessionId, sendMessage, stopStreaming, newConversation, loadSession };
}
