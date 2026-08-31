import { FolderPlus } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "../../../shared/ui/popover";
import type { ThreadListController } from "../hooks/use-thread-list";

/**
 * 「工作区」区头 —— 标题 + hover 出的新建按钮。
 *
 * 点按钮先试原生目录框(Electron / server 弹);弹不出来才落到这个手输路径的
 * Popover 上,所以 onClick 里要 preventDefault 拦住 Popover 的默认打开。
 */
export function WorkspaceAddPopover({
  add
}: {
  readonly add: ThreadListController["workspaceAdd"];
}) {
  return (
    <div className="group flex w-full items-center justify-between px-1.5 pb-1 pt-1">
      <span className="text-sm font-semibold uppercase tracking-wider text-muted-foreground select-none h-8 flex items-center">
        工作区
      </span>
      <Popover open={add.open} onOpenChange={add.setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
            onClick={(e) => {
              // 先尝试原生目录框(Electron / server 弹);能弹就拦截默认开 Popover。
              e.preventDefault();
              void add.start();
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
            value={add.pathInput}
            onChange={(e) => add.setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add.submitPath(add.pathInput);
              if (e.key === "Escape") add.setOpen(false);
            }}
          />
          {add.error ? (
            <p className="mt-2 break-words text-xs text-destructive">{add.error}</p>
          ) : null}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => add.setOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              disabled={add.submitting || !add.pathInput.trim()}
              className="text-xs text-primary disabled:opacity-40"
              onClick={() => void add.submitPath(add.pathInput)}
            >
              添加
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
