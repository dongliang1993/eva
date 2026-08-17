import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useChat } from "../../hooks/use-chat";
import { useApprovals } from "../../hooks/use-approvals";
import { useSettings } from "../../hooks/use-settings";
import { Sidebar } from "../../components/sidebar";
import { ChatView } from "../../components/chat-view";
import { ResizableSidebar } from "../../components/ui/resizable-sidebar";

export function ChatPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const { messages, isStreaming, sessionId, sendMessage, stopStreaming, newConversation, loadSession } = useChat();
  const settings = useSettings();

  // 「始终允许」→ 打开工具自动审批, 之后的危险工具不再逐条弹。
  const enableAutoApprove = (): Promise<void> | void => {
    const current = settings.data;
    if (!current) return;
    settings.saveSettings({
      ...current,
      security: { ...current.security, autoApproveToolRequests: true }
    });
  };
  const approvals = useApprovals(enableAutoApprove);

  // Load session from URL on mount (once)
  const threadIdFromUrl = searchParams.get("threadId");
  const initialLoadDone = useRef(false);

  useEffect(() => {
    if (threadIdFromUrl && !initialLoadDone.current) {
      initialLoadDone.current = true;
      loadSession(threadIdFromUrl);
    }
  }, [threadIdFromUrl, loadSession]);

  // When a new session is created (first message), sync to URL once
  const prevSessionId = useRef<string | null>(null);

  useEffect(() => {
    if (
      sessionId &&
      prevSessionId.current === null &&
      sessionId !== threadIdFromUrl
    ) {
      setSearchParams({ threadId: sessionId }, { replace: true });
    }
    prevSessionId.current = sessionId;
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  const handleNewChat = useCallback(() => {
    newConversation();
    setSearchParams({}, { replace: true });
  }, [newConversation, setSearchParams]);

  const handleSelectThread = useCallback((threadId: string) => {
    setSearchParams({ threadId }, { replace: true });
    loadSession(threadId);
  }, [setSearchParams, loadSession]);

  const handleOpenSettings = useCallback(() => {
    navigate("/settings");
  }, [navigate]);

  const handleOpenAgentLab = useCallback(() => {
    navigate("/agent-lab");
  }, [navigate]);

  return (
    <div className="h-screen bg-background text-foreground">
      <div className="titlebar-drag h-11 w-full fixed top-0 left-0 z-50" />
      <ResizableSidebar
        sidebar={
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggle={handleToggleSidebar}
            onNewChat={handleNewChat}
            onOpenSettings={handleOpenSettings}
            onOpenAgentLab={handleOpenAgentLab}
            onSelectThread={handleSelectThread}
            sessionId={sessionId}
          />
        }
      >
        <ChatView
          messages={messages}
          isStreaming={isStreaming}
          selectedModel={selectedModel}
          onSend={(text) => sendMessage(text, selectedModel ?? undefined)}
          onStop={stopStreaming}
          onSelectModel={setSelectedModel}
          pendingApprovals={approvals.pending}
          onApproveOnce={(callId) => approvals.decide(callId, true)}
          onDeny={(callId) => approvals.decide(callId, false)}
          onAllowAlways={(callId) => approvals.allowAlways(callId)}
        />
      </ResizableSidebar>
    </div>
  );
}
