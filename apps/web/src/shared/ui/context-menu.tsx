import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import type { ComponentPropsWithoutRef } from "react";

/**
 * 通用右键菜单(沉淀自 thread 重命名,后续删除/收藏等操作复用)。
 *
 * 用法:
 *   <ContextMenu>
 *     <ContextMenuTrigger asChild><button>…</button></ContextMenuTrigger>
 *     <ContextMenuContent>
 *       <ContextMenuItem onSelect={…}>重命名</ContextMenuItem>
 *       <ContextMenuSeparator />
 *       <ContextMenuItem destructive onSelect={…}>删除</ContextMenuItem>
 *     </ContextMenuContent>
 *   </ContextMenu>
 *
 * Trigger 用 asChild 包业务元素 —— Radix 接管它的 onContextMenu(右键)与长按,
 * 样式与 popover.tsx 那套动画/边框对齐。
 */

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuSeparator = ({
  className = "",
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>) => (
  <ContextMenuPrimitive.Separator
    className={`-mx-1 my-1 h-px bg-border ${className}`}
    {...props}
  />
);

export function ContextMenuContent({
  className = "",
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={`z-50 min-w-40 rounded-xl border border-border bg-popover p-1 shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 ${className}`}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className = "",
  destructive = false,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
  /** 危险操作(删除等)标红。 */
  readonly destructive?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Item
      className={`flex cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent ${
        destructive
          ? "text-destructive data-[highlighted]:text-destructive"
          : "text-foreground"
      } ${className}`}
      {...props}
    />
  );
}
