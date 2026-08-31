import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../../../shared/ui/dropdown-menu";
import type { ThreadGroup } from "../hooks/use-thread-list";

/** 工作区重命名的内联输入框(整行替换组头)。Enter 提交 / Esc 或失焦取消。 */
export function WorkspaceRenameInput({
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
 * 组头 —— 整行可点折叠/展开;工作区额外在行尾露「⋯」(重命名/删除)与「+」(新建 thread)。
 */
export function ThreadGroupHeader({
  group,
  isCollapsed,
  onToggle,
  onStartRenameWorkspace,
  onDeleteWorkspace,
  onNewThreadInWorkspace
}: {
  readonly group: ThreadGroup;
  readonly isCollapsed: boolean;
  readonly onToggle: () => void;
  readonly onStartRenameWorkspace: (id: string) => void;
  readonly onDeleteWorkspace: (workspace: NonNullable<ThreadGroup["workspace"]>) => void;
  readonly onNewThreadInWorkspace: (workspaceId: string) => void;
}) {
  const ws = group.workspace;
  const isUncategorized = ws === null;

  return (
    <div
      role="button"
      tabIndex={0}
      className="group flex h-8.5 w-full cursor-pointer items-center gap-1.5 rounded-lg px-1.5 transition-colors hover:bg-accent"
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
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
              <DropdownMenuItem onSelect={() => onStartRenameWorkspace(ws.id)}>
                <Pencil size={13} />
                重命名
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                onSelect={() => onDeleteWorkspace(ws)}
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
  );
}
