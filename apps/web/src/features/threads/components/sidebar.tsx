import { useQuery } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeft, SquarePen, Settings } from "lucide-react";

import { apiFetch } from "../../../shared/api/fetch";
import { isElectron } from "../../../shared/runtime";
import type { ThreadSummary } from "../../../types/api";
import { SessionStatusDot } from "./session-status-dot";
import { ThemeToggle } from "../../../shared/ui/theme-toggle";

interface SidebarProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onNewChat: () => void;
  readonly onOpenSettings: () => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly sessionId: string | null;
}

/**
 * 侧栏: 折叠/展开由外层 Panel 宽度 + 下方 index.css 的 flex-grow transition 驱动,
 * 这里保持单一根容器 (背景跟随 Panel 动画), 内部按 collapsed 条件渲染内容。
 */
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

  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-border bg-sidebar">
      {/* Drag region spacer — 小程序化, 让折叠按钮避开上方全局 titlebar-drag 拦截层;
          只在 Electron 下渲染(浏览器没有自定义标题栏) */}
      {isElectron() ? (
        <div className="titlebar-drag h-11 w-full shrink-0" />
      ) : null}

      {/* Header: brand + collapse toggle */}
      <div
        className={`flex shrink-0 items-center ${
          collapsed ? "justify-center py-3" : "justify-between px-3 py-2"
        }`}
      >
        {!collapsed && (
          <span className="text-base font-bold text-foreground select-none">Eva</span>
        )}
        <button
          type="button"
          className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>

      {/* New chat — 展开=全宽主按钮 / 折叠=居中图标 */}
      <div className={`shrink-0 ${collapsed ? "px-1 pb-1" : "px-3 pb-2"}`}>
        {collapsed ? (
          <button
            type="button"
            className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            onClick={onNewChat}
            title="New chat"
          >
            <SquarePen size={18} />
          </button>
        ) : (
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={onNewChat}
            title="New chat"
          >
            <SquarePen size={16} />
            <span>新会话</span>
          </button>
        )}
      </div>

      {/* Thread list (展开) / 弹性占位 (折叠) */}
      {collapsed ? (
        <div className="flex-1" />
      ) : (
        <div className="flex-1 overflow-y-auto px-2">
          {threads.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">No conversations yet</p>
          ) : (
            <div className="space-y-1">
              {threads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-lg px-3.5 py-2 text-left text-sm transition-colors ${
                    thread.id === sessionId
                      ? "bg-sidebar-active text-sidebar-active-foreground font-medium"
                      : "text-foreground hover:bg-accent"
                  }`}
                  onClick={() => onSelectThread(thread.id)}
                >
                  <SessionStatusDot status={thread.status} />
                  <span className="flex-1 truncate">{thread.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Bottom: theme toggle + settings */}
      <div
        className={`shrink-0 ${
          collapsed
            ? "flex flex-col items-center gap-1 py-2"
            : "flex items-center justify-between px-2 py-2"
        }`}
      >
        <ThemeToggle />
        <button
          type="button"
          className={`flex items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors ${
            collapsed ? "h-9 w-9 justify-center" : "flex-1 justify-start gap-2 px-2.5 py-2 text-sm"
          }`}
          onClick={onOpenSettings}
          title="Settings"
        >
          <Settings size={16} />
          {!collapsed && <span>Settings</span>}
        </button>
      </div>
    </div>
  );
}