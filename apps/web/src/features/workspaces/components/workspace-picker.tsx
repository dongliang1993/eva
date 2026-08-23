import { useState } from "react";
import { Check, ChevronDown, Folder, Plus } from "lucide-react";

import type { Workspace } from "../../../types/api";
import { extractErrorText } from "../api";
import { useWorkspaces } from "../hooks/use-workspaces";
import { pickWorkspaceDirectory } from "../pick-directory";
import { Popover, PopoverContent, PopoverTrigger } from "../../../shared/ui/popover";
import { Tooltip, TooltipProvider } from "../../../shared/ui/tooltip";

interface WorkspacePickerProps {
  readonly workspaceId: string | null;
  readonly onSelect: (workspaceId: string | null) => void;
}

export function WorkspacePicker({ workspaceId, onSelect }: WorkspacePickerProps) {
  const { workspaces, add } = useWorkspaces();
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const current = workspaces.find((w) => w.id === workspaceId) ?? null;

  const submitPath = async (pathValue: string) => {
    if (!pathValue.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const created = await add.mutateAsync({ path: pathValue.trim() });
      onSelect(created.id);
      setShowAdd(false);
      setPathInput("");
    } catch (err) {
      setError(extractErrorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAdd = async () => {
    // Electron IPC → server 弹系统框,拿到绝对路径直接建并选中;取消静默;
    // 只有都弹不出才回落手输路径(与侧栏新建工作区一致)。
    const result = await pickWorkspaceDirectory();
    if (result.kind === "picked") {
      await submitPath(result.path);
      return;
    }
    if (result.kind === "cancelled") return;

    setShowAdd(true);
    setError(null);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip content={current?.path ?? "未选择工作区"}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent transition-colors"
            >
              <Folder size={12} />
              <span className={current ? "text-foreground" : "text-muted-foreground"}>
                {current ? current.name : "未选择工作区"}
              </span>
              <ChevronDown className="mt-[2px]" size={12} />
            </button>
          </PopoverTrigger>
        </Tooltip>

        <PopoverContent className="w-72 p-0" side="top" align="start">
          {showAdd ? (
            <div className="p-3">
              <p className="text-xs text-muted-foreground mb-2">输入本地目录路径</p>
              <input
                type="text"
                autoFocus
                className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none"
                placeholder="/path/to/project"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitPath(pathInput);
                  if (e.key === "Escape") {
                    setShowAdd(false);
                    setError(null);
                  }
                }}
              />
              {error ? (
                <p className="text-xs text-destructive mt-2 break-words">{error}</p>
              ) : null}
              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setShowAdd(false);
                    setError(null);
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={submitting || !pathInput.trim()}
                  className="text-xs text-primary disabled:opacity-40"
                  onClick={() => submitPath(pathInput)}
                >
                  添加
                </button>
              </div>
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto py-1">
              <button
                type="button"
                className={`flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors rounded-md ${workspaceId === null
                  ? "bg-accent"
                  : "hover:bg-accent/50"
                  }`}
                onClick={() => {
                  onSelect(null);
                  setOpen(false);
                }}
              >
                <span className="text-sm text-muted-foreground">未绑定(纯聊天)</span>
                {workspaceId === null ? <Check size={14} /> : null}
              </button>

              {workspaces.map((workspace: Workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className={`flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors rounded-md ${workspace.id === workspaceId
                    ? "bg-accent"
                    : "hover:bg-accent/50"
                    }`}
                  onClick={() => {
                    onSelect(workspace.id);
                    setOpen(false);
                  }}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">
                      {workspace.name}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{workspace.path}</div>
                  </div>
                  {workspace.id === workspaceId ? <Check size={14} /> : null}
                </button>
              ))}

              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-muted-foreground rounded-md hover:bg-accent/50 transition-colors"
                onClick={handleAdd}
              >
                <Plus size={14} />
                <span>添加工作区…</span>
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}