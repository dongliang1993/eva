import { useQuery } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeft, SquarePen, Settings } from "lucide-react";

import { apiFetch } from "../../../shared/api/fetch";
import type { ThreadSummary } from "../../../types/api";

interface SidebarProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onNewChat: () => void;
  readonly onOpenSettings: () => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly sessionId: string | null;
}

export function Sidebar({
  collapsed,
  onToggle,
  onNewChat,
  onOpenSettings,
  onSelectThread,
  sessionId
}: SidebarProps) {
  const { data } = useQuery({
    queryKey: ["threads"],
    queryFn: () => apiFetch<readonly ThreadSummary[]>("/api/v1/threads"),
    refetchInterval: 10_000
  });

  const threads = data ?? [];

  if (collapsed) {
    return (
      <div className="flex h-full w-12 flex-col items-center border-r border-border bg-sidebar py-3 gap-2">
        <div className="titlebar-drag h-10 w-full shrink-0" />
        <button
          type="button"
          className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          onClick={onToggle}
          title="Expand sidebar"
        >
          <PanelLeft size={18} />
        </button>
        <button
          type="button"
          className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          onClick={onNewChat}
          title="New chat"
        >
          <SquarePen size={18} />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          onClick={onOpenSettings}
          title="Settings"
        >
          <Settings size={18} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-sidebar">
      {/* Header buttons */}
      <div className="flex items-center justify-between px-3 py-3 mt-4.5">
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          onClick={onToggle}
          title="Collapse sidebar"
        >
          <PanelLeftClose size={18} />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          onClick={onNewChat}
          title="New chat"
        >
          <SquarePen size={18} />
        </button>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto px-2">
        {threads.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">No conversations yet</p>
        ) : (
          <div className="space-y-1">
            {threads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className={`flex w-full items-center gap-2 rounded-lg px-3.5 py-2 text-left text-sm transition-colors ${thread.id === sessionId
                  ? "bg-sidebar-active text-sidebar-active-foreground font-medium"
                  : "text-foreground hover:bg-accent"
                  }`}
                onClick={() => onSelectThread(thread.id)}
              >
                <span className="flex-1 truncate">{thread.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Bottom: settings */}
      <div className="px-2 py-2">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          onClick={onOpenSettings}
        >
          <Settings size={16} />
          <span>Settings</span>
        </button>
      </div>
    </div>
  );
}