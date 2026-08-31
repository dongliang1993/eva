import type { ReactNode } from "react";
import { Pencil, Trash2 } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "../../../shared/ui/context-menu";

/** 会话行的右键菜单(重命名 / 删除)—— 包住整行,菜单项只发意图。 */
export function ThreadContextMenu({
  onStartRename,
  onDelete,
  children
}: {
  readonly onStartRename: () => void;
  readonly onDelete: () => void;
  readonly children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
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
