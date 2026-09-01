import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

/**
 * Radix Dialog 的主题化封装 —— 与 select.tsx 同一套约定:
 * Root/Trigger 原样转出,带样式的部分(Overlay/Content/Title/Close)在这里收口。
 *
 * Esc 关闭、点遮罩关闭、焦点圈定、body 滚动锁都由 radix 提供,
 * 调用方不要再自己写 window keydown / mousedown target 判定。
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogOverlay({
  className = "",
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={`fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 ${className}`}
      {...props}
    />
  );
}

export function DialogContent({
  className = "",
  children,
  showCloseButton = true,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  /** 右上角 X。内容自带关闭入口(如 footer 取消)时可关掉。 */
  readonly showCloseButton?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={`fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card shadow-xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 ${className}`}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="关闭"
          >
            <X size={16} />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({
  className = "",
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={`text-base font-semibold text-foreground ${className}`}
      {...props}
    />
  );
}

/** 描述文本。radix 要求 Title 配 Description(读屏器);纯装饰场景可静默。 */
export function DialogDescription({
  className = "",
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={`text-sm text-muted-foreground ${className}`}
      {...props}
    />
  );
}
