import { type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

interface ResizableSidebarProps {
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
  readonly defaultSize?: number;
  readonly minSizePixels?: number;
  readonly maxSizePixels?: number;
}

export function ResizableSidebar({
  sidebar,
  children,
  defaultSize = 240,
  minSizePixels = 200,
  maxSizePixels = 400
}: ResizableSidebarProps) {
  return (
    <Group orientation="horizontal" className="h-full">
      <Panel
        defaultSize={defaultSize}
        minSize={minSizePixels}
        maxSize={maxSizePixels}
      >
        {sidebar}
      </Panel>

      <Separator className="group relative w-0 flex-none outline-none">
        <div className="absolute inset-y-0 -left-px w-px bg-border group-hover:w-[2px] group-hover:bg-primary/40 group-data-[active]:w-[2px] group-data-[active]:bg-primary transition-all" />
        <div className="absolute inset-y-0 -left-1 w-2 cursor-col-resize" />
      </Separator>

      <Panel>
        {children}
      </Panel>
    </Group>
  );
}
