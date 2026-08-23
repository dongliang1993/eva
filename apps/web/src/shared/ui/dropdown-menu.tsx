import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentPropsWithoutRef } from "react";

/**
 * 通用下拉菜单(沉淀自工作区「⋯」操作菜单,后续更多 hover 触发的操作复用)。
 *
 * 与 context-menu.tsx 的区别:这个是**左键/点击**触发(hover 露出的「⋯」按钮),
 * 那个是右键触发。样式与 popover/context-menu 那套动画/边框对齐。
 *
 * 用法:
 *   <DropdownMenu>
 *     <DropdownMenuTrigger asChild><button>⋯</button></DropdownMenuTrigger>
 *     <DropdownMenuContent>
 *       <DropdownMenuItem onSelect={…}>重命名</DropdownMenuItem>
 *       <DropdownMenuSeparator />
 *       <DropdownMenuItem destructive onSelect={…}>删除</DropdownMenuItem>
 *     </DropdownMenuContent>
 *   </DropdownMenu>
 */

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuSeparator = ({
  className = "",
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>) => (
  <DropdownMenuPrimitive.Separator
    className={`-mx-1 my-1 h-px bg-border ${className}`}
    {...props}
  />
);

export function DropdownMenuContent({
  className = "",
  sideOffset = 6,
  align = "end",
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={`z-50 min-w-40 rounded-xl border border-border bg-popover p-1 shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 ${className}`}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className = "",
  destructive = false,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
  /** 危险操作(删除等)标红。 */
  readonly destructive?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Item
      className={`flex cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent ${
        destructive
          ? "text-destructive data-[highlighted]:text-destructive"
          : "text-foreground"
      } ${className}`}
      {...props}
    />
  );
}
