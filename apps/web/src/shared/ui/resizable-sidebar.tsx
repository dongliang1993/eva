import { useEffect, type ReactNode } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";

interface ResizableSidebarProps {
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
  readonly defaultSize?: number;
  readonly minSizePixels?: number;
  readonly maxSizePixels?: number;
  /** 折叠状态(由外部控制, 与拖拽/双击双向同步) */
  readonly collapsed?: boolean;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
  /** 折叠后的宽度(px)。默认 48(留一条窄轨条);Electron 下传 0 完全收起。 */
  readonly collapsedSizePixels?: number;
}

/**
 * 可拖拽 + 可折叠的双栏布局。
 *
 * 折叠行为对齐 DeepSeek Harness: 折叠 = 外层 Panel 真正收到 48px 轨条,
 * 而不是只把内部内容切成窄栏却留一片空白。
 */
export function ResizableSidebar({
  sidebar,
  children,
  defaultSize = 280,
  minSizePixels = 220,
  maxSizePixels = 420,
  collapsed = false,
  onCollapsedChange,
  collapsedSizePixels = 48
}: ResizableSidebarProps) {
  const panelRef = usePanelRef();

  // 外部状态变化 → 驱动 Panel 折叠/展开
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    if (collapsed && !panel.isCollapsed()) {
      panel.collapse();
    } else if (!collapsed && panel.isCollapsed()) {
      panel.expand();
    }
  }, [collapsed, panelRef]);

  return (
    <Group orientation="horizontal" className="h-full">
      <Panel
        panelRef={panelRef}
        defaultSize={defaultSize}
        minSize={minSizePixels}
        maxSize={maxSizePixels}
        collapsible
        collapsedSize={collapsedSizePixels}
        style={{
          overflow: 'hidden'
        }}
        onResize={() => {
          // 拖拽把 Panel 折叠/展开时, 反向同步外部状态
          onCollapsedChange?.(panelRef.current?.isCollapsed() ?? false);
        }}
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