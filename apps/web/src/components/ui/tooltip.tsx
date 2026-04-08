import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className = "",
  sideOffset = 6,
  ...props
}: ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={`z-50 rounded-lg border border-border bg-popover px-3 py-1.5 text-xs text-foreground shadow-md ${className}`}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export function Tooltip({
  children,
  content,
  side = "top"
}: {
  readonly children: ReactNode;
  readonly content: string;
  readonly side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </TooltipRoot>
  );
}
