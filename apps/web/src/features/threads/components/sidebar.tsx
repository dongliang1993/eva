import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PanelLeftClose,
  PanelLeft,
  SquarePen,
  Settings,
  Folder,
  Plus,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Pencil,
  Trash2,
  MoreHorizontal
} from "lucide-react";

import { apiFetch } from "../../../shared/api/fetch";
import { isElectron } from "../../../shared/runtime";
import type { ThreadSummary, Workspace } from "../../../types/api";
import { extractErrorText } from "../../workspaces/api";
import { pickWorkspaceDirectory } from "../../workspaces/pick-directory";
import { useWorkspaces } from "../../workspaces/hooks/use-workspaces";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "../../../shared/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../../../shared/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../../../shared/ui/popover";
import { deleteThread, renameThread } from "../api";
import { SessionStatusDot } from "./session-status-dot";

interface SidebarProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onNewChat: () => void;
  readonly onOpenSettings: () => void;
  readonly onSelectThread: (threadId: string) => void;
  /** 工作区模式下,在某工作区下新建 thread(首条消息后延迟绑定到该工作区)。 */
  readonly onNewThreadInWorkspace: (workspaceId: string) => void;
  /** 删除 thread(级联硬删,调用方善后: 删的是当前会话要退回新会话页)。 */
  readonly onDeleteThread: (threadId: string) => void;
  readonly sessionId: string | null;
}

/** 「未分类」组的固定 id(workspace 为 null 的桶)。 */
const UNCATEGORIZED_ID = "__uncategorized__";

interface ThreadGroup {
  readonly id: string;
  readonly workspace: Workspace | null;
  readonly threads: readonly ThreadSummary[];
  /** 组内最新 thread 的 updatedAt(组排序用);空组为 ""。 */
  readonly latest: string;
}

/** 单条 thread 按钮(原扁平列表的样式原样保留)。右键出菜单(重命名 / 删除)。 */
function ThreadButton({
  thread,
  active,
  renaming,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete
}: {
  readonly thread: ThreadSummary;
  readonly active: boolean;
  readonly renaming: boolean;
  readonly onSelect: () => void;
  readonly onStartRename: () => void;
  readonly onCommitRename: (title: string) => void;
  readonly onCancelRename: () => void;
  readonly onDelete: () => void;
}) {
  const [draft, setDraft] = useState(thread.title);

  if (renaming) {
    return (
      <div
        className={`flex w-full items-center gap-2 rounded-lg py-2 pl-6 pr-3.5 ${
          active ? "bg-sidebar-active" : "bg-accent/50"
        }`}
      >
        <SessionStatusDot status={thread.status} />
        <input
          type="text"
          autoFocus
          className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-primary"
          defaultValue={thread.title}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const t = draft.trim();
              if (t && t !== thread.title) onCommitRename(t);
              else onCancelRename();
            }
            if (e.key === "Escape") onCancelRename();
          }}
          onBlur={onCancelRename}
        />
      </div>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          className={`flex w-full items-center gap-2 rounded-lg py-2 pl-6 pr-3.5 text-left text-sm transition-colors ${
            active
              ? "bg-sidebar-active text-sidebar-active-foreground font-medium"
              : "text-foreground hover:bg-accent"
          }`}
          onClick={onSelect}
          title={thread.title}
        >
          <SessionStatusDot status={thread.status} />
          <span className="flex-1 truncate">{thread.title}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onStartRename}>
          <Pencil size={13} />
          重命名
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem destructive onSelect={onDelete}>
          <Trash2 size={13} />
          删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 工作区重命名的内联输入框(整行替换组头)。Enter 提交 / Esc 或失焦取消。 */
function WorkspaceRenameInput({
  initialName,
  onCommit,
  onCancel
}: {
  readonly initialName: string;
  readonly onCommit: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialName);

  return (
    <div className="flex h-8.5 w-full items-center gap-1.5 rounded-lg px-1.5">
      <Folder size={14} className="shrink-0 text-muted-foreground" />
      <input
        type="text"
        autoFocus
        className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-primary"
        defaultValue={initialName}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const name = draft.trim();
            if (name && name !== initialName) onCommit(name);
            else onCancel();
          }
          if (e.key === "Escape") onCancel();
        }}
        onBlur={onCancel}
      />
    </div>
  );
}

/**
 * 侧栏: 折叠/展开由外层 Panel 宽度 + 下方 index.css 的 flex-grow transition 驱动,
 * 这里保持单一根容器 (背景跟随 Panel 动画), 内部按 collapsed 条件渲染内容。
 *
 * 工作区模式: thread 按 workspaceId 分组 —— 每个 workspace 一组(组头可折叠、可
 * 「+」新建 thread),未绑定的 thread 归「未分类」垫底。
 */
export function Sidebar({
  collapsed,
  onToggle,
  onNewChat,
  onOpenSettings,
  onSelectThread,
  onNewThreadInWorkspace,
  onDeleteThread,
  sessionId
}: SidebarProps) {
  const { data } = useQuery({
    queryKey: ["threads"],
    queryFn: () => apiFetch<readonly ThreadSummary[]>("/api/v1/threads"),
    refetchInterval: 10_000
  });
  const { workspaces, add, rename: renameWs, remove: removeWorkspace } = useWorkspaces();

  const threads = useMemo(() => data ?? [], [data]);

  // 重命名 thread(右键 → 内联输入框)。renamingId = 正在编辑的 thread id。
  const queryClient = useQueryClient();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameThread(id, title),
    onSuccess: () => {
      setRenamingId(null);
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
    },
    onError: () => setRenamingId(null)
  });

  // 删除 thread: 级联硬删(messages/runs/usage_records 都 cascade),先确认再删。
  const remove = useMutation({
    mutationFn: (id: string) => deleteThread(id),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      onDeleteThread(id); // 父组件善后: 删的是当前会话就退回新会话页
    }
  });
  const confirmDelete = (thread: ThreadSummary) => {
    if (
      window.confirm(
        `删除会话「${thread.title}」？\n\n会一并删除它的所有消息和运行记录,不可恢复。`
      )
    ) {
      remove.mutate(thread.id);
    }
  };

  // 重命名 / 删除工作区(hover 组头「⋯」菜单 → 内联输入 / 确认后删)。删除走的是
  // FK SET NULL —— 组下 thread 不会丢,只会被解绑回「未分类」。rename/remove 直接
  // 复用 useWorkspaces 的 mutation(成功即失效 workspaces 查询);这里只管编辑态。
  const [renamingWsId, setRenamingWsId] = useState<string | null>(null);
  const commitRenameWorkspace = (id: string, name: string) =>
    renameWs.mutate(
      { id, name },
      { onSettled: () => setRenamingWsId(null) }
    );
  const confirmDeleteWorkspace = (ws: Workspace) => {
    const count = threads.filter((t) => t.workspaceId === ws.id).length;
    const detail =
      count > 0
        ? `\n\n它下面的 ${count} 个会话不会被删除,只会移回「未分类」。`
        : "";
    if (window.confirm(`删除工作区「${ws.name}」？${detail}`)) {
      removeWorkspace.mutate(ws.id);
    }
  };

  // 折叠的组 id 集合(默认全部展开)。
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (id: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 按 workspaceId 分桶 + 排序:「未分类」在最前(默认/未绑定的会话),其后是有
  // thread 的工作区(按各自最新 thread 倒序),空工作区垫底。脏数据(指向已删
  // workspace)归未分类。
  const groups = useMemo<readonly ThreadGroup[]>(() => {
    const known = new Set(workspaces.map((w) => w.id));
    const byWorkspace = new Map<string, ThreadSummary[]>();
    const uncategorized: ThreadSummary[] = [];
    for (const t of threads) {
      if (t.workspaceId && known.has(t.workspaceId)) {
        const list = byWorkspace.get(t.workspaceId) ?? [];
        list.push(t);
        byWorkspace.set(t.workspaceId, list);
      } else {
        uncategorized.push(t);
      }
    }

    const latestOf = (list: readonly ThreadSummary[]): string =>
      list.reduce((max, t) => (t.updatedAt > max ? t.updatedAt : max), "");

    const withThreads: ThreadGroup[] = [];
    const empty: ThreadGroup[] = [];
    for (const w of workspaces) {
      const list = byWorkspace.get(w.id) ?? [];
      const group: ThreadGroup = {
        id: w.id,
        workspace: w,
        threads: list,
        latest: latestOf(list)
      };
      (list.length > 0 ? withThreads : empty).push(group);
    }
    withThreads.sort((a, b) => (a.latest < b.latest ? 1 : -1));

    const result: ThreadGroup[] = [];
    if (uncategorized.length > 0) {
      result.push({
        id: UNCATEGORIZED_ID,
        workspace: null,
        threads: uncategorized,
        latest: latestOf(uncategorized)
      });
    }
    result.push(...withThreads, ...empty);
    return result;
  }, [threads, workspaces]);

  // 新建工作区(Electron 原生选目录 / 浏览器 File System Access 选目录 / 都不行才手输)。
  const [addOpen, setAddOpen] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addSubmitting, setAddSubmitting] = useState(false);

  const submitWorkspacePath = async (pathValue: string) => {
    if (!pathValue.trim()) return;
    setAddSubmitting(true);
    setAddError(null);
    try {
      await add.mutateAsync({ path: pathValue.trim() });
      setAddOpen(false);
      setPathInput("");
    } catch (err) {
      setAddError(extractErrorText(err));
    } finally {
      setAddSubmitting(false);
    }
  };

  const handleAddWorkspace = async () => {
    // Electron IPC → server 弹系统框,拿到绝对路径直接建;取消静默;只有都
    // 弹不出才回落手输路径 Popover。
    const result = await pickWorkspaceDirectory();
    if (result.kind === "picked") {
      await submitWorkspacePath(result.path);
      return;
    }
    if (result.kind === "cancelled") return;
    setAddOpen(true);
    setAddError(null);
  };

  const renderThreadList = (list: readonly ThreadSummary[]) => (
    <div className="space-y-1">
      {list.map((thread) => (
        <ThreadButton
          key={thread.id}
          thread={thread}
          active={thread.id === sessionId}
          renaming={renamingId === thread.id}
          onSelect={() => onSelectThread(thread.id)}
          onStartRename={() => setRenamingId(thread.id)}
          onCommitRename={(title) => rename.mutate({ id: thread.id, title })}
          onCancelRename={() => setRenamingId(null)}
          onDelete={() => confirmDelete(thread)}
        />
      ))}
    </div>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-border bg-sidebar">
      {/* Drag region spacer — 小程序化, 让折叠按钮避开上方全局 titlebar-drag 拦截层;
          只在 Electron 下渲染(浏览器没有自定义标题栏) */}
      {isElectron() ? (
        <div className="titlebar-drag h-11 w-full shrink-0" />
      ) : null}

      {/* Header: brand + collapse toggle */}
      <div
        className={`flex mb-2 shrink-0 items-center ${
          collapsed ? "justify-center py-3" : "justify-between px-3 py-2"
        }`}
      >
        {!collapsed && (
          <span className="text-base font-bold text-foreground select-none">Eva</span>
        )}
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeft size={18} /> : <PanelLeft size={18} />}
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

      {/* Thread 列表(按工作区分组, 展开) / 弹性占位 (折叠) */}
      {collapsed ? (
        <div className="flex-1" />
      ) : (
        <div className="flex-1 overflow-y-auto px-2">
          {/* 「工作区」区头: 标题 + hover 出行尾新建按钮(原生选目录 / 手输路径) */}
          <div className="group flex w-full items-center justify-between px-1.5 pb-1 pt-1">
            <span className="text-sm font-semibold uppercase tracking-wider text-muted-foreground select-none h-8 flex items-center">
              工作区
            </span>
            <Popover
              open={addOpen}
              onOpenChange={(o) => {
                setAddOpen(o);
                if (!o) setAddError(null);
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
                  onClick={(e) => {
                    // 先尝试原生目录框(Electron / server 弹);能弹就拦截默认开 Popover。
                    e.preventDefault();
                    void handleAddWorkspace();
                  }}
                  title="新建工作区"
                >
                  <FolderPlus size={14} />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-3" side="bottom" align="end">
                <p className="mb-2 text-xs text-muted-foreground">输入本地目录路径</p>
                <input
                  type="text"
                  autoFocus
                  className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none"
                  placeholder="/path/to/project"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitWorkspacePath(pathInput);
                    if (e.key === "Escape") {
                      setAddOpen(false);
                      setAddError(null);
                    }
                  }}
                />
                {addError ? (
                  <p className="mt-2 break-words text-xs text-destructive">{addError}</p>
                ) : null}
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setAddOpen(false);
                      setAddError(null);
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={addSubmitting || !pathInput.trim()}
                    className="text-xs text-primary disabled:opacity-40"
                    onClick={() => void submitWorkspacePath(pathInput)}
                  >
                    添加
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          </div>

          {groups.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">No conversations yet</p>
          ) : (
            <div>
              {groups.map((group) => {
                const isCollapsed = collapsedGroups.has(group.id);
                const isUncategorized = group.workspace === null;
                const ws = group.workspace;
                const renamingThisWs = ws !== null && renamingWsId === ws.id;

                return (
                  <div key={group.id}>
                    {/* 组头: 重命名态是输入框;正常态整行可点折叠/展开,hover 出背景,
                        工作区额外在行尾露「⋯」(重命名/删除)与「+」(新建 thread)。 */}
                    {renamingThisWs && ws !== null ? (
                      <WorkspaceRenameInput
                        key={ws.id}
                        initialName={ws.name}
                        onCommit={(name) => commitRenameWorkspace(ws.id, name)}
                        onCancel={() => setRenamingWsId(null)}
                      />
                    ) : (
                      <div
                        role="button"
                        tabIndex={0}
                        className="group flex h-8.5 w-full cursor-pointer items-center gap-1.5 rounded-lg px-1.5 transition-colors hover:bg-accent"
                        onClick={() => toggleGroup(group.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggleGroup(group.id);
                          }
                        }}
                        title={isCollapsed ? "展开" : "折叠"}
                      >
                        {/* icon 与 chevron 共用一个 16px 槽位(对齐 disclosure-row):
                            默认显示 folder/状态,hover 就地换成 chevron。同槽位 → 不抖动。 */}
                        <span className="relative inline-flex h-4 w-4 flex-none items-center justify-center text-muted-foreground">
                          <span className="inline-flex items-center justify-center transition-opacity duration-100 group-hover:opacity-0">
                            {isUncategorized || ws === null ? (
                              <ChevronDown size={16} />
                            ) : (
                              <Folder size={16} />
                            )}
                          </span>
                          <span className="absolute inset-0 inline-flex items-center justify-center opacity-0 transition-opacity duration-100 group-hover:opacity-100">
                            {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                          </span>
                        </span>
                        {isUncategorized || ws === null ? (
                          <span className="truncate text-sm font-medium text-muted-foreground">
                            未分类
                          </span>
                        ) : (
                          <span
                            className="truncate text-sm font-medium text-foreground"
                            title={ws.path}
                          >
                            {ws.name}
                          </span>
                        )}

                        {ws !== null ? (
                          <span className="ml-auto flex shrink-0 items-center gap-0.5">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
                                  onClick={(e) => e.stopPropagation()}
                                  title="工作区操作"
                                >
                                  <MoreHorizontal size={14} />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
                                <DropdownMenuItem onSelect={() => setRenamingWsId(ws.id)}>
                                  <Pencil size={13} />
                                  重命名
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  destructive
                                  onSelect={() => confirmDeleteWorkspace(ws)}
                                >
                                  <Trash2 size={13} />
                                  删除工作区
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <button
                              type="button"
                              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
                              onClick={(e) => {
                                e.stopPropagation();
                                onNewThreadInWorkspace(ws.id);
                              }}
                              title={`在「${ws.name}」下新建会话`}
                            >
                              <Plus size={14} />
                            </button>
                          </span>
                        ) : null}
                      </div>
                    )}

                    {/* 组内 thread(展开时) */}
                    {!isCollapsed && group.threads.length > 0 && (
                      <div className="mt-0.5">{renderThreadList(group.threads)}</div>
                    )}
                    {!isCollapsed && group.threads.length === 0 && !isUncategorized && (
                      <p className="py-1 pl-6 text-xs text-muted-foreground/70">无会话</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Bottom: settings */}
      <div
        className={`shrink-0 ${
          collapsed
            ? "flex flex-col items-center gap-1 py-2"
            : "flex items-center px-2 py-2"
        }`}
      >
        <button
          type="button"
          className={`flex items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors ${
            collapsed ? "h-9 w-9 justify-center" : "flex-1 justify-start gap-2 px-2.5 py-2 text-sm"
          }`}
          onClick={onOpenSettings}
          title="设置"
        >
          <Settings size={16} />
          {!collapsed && <span>设置</span>}
        </button>
      </div>
    </div>
  );
}
