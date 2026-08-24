import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { isElectron } from "../../../shared/runtime";

interface SettingsHeaderProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly children?: ReactNode;
}

export function SettingsHeader({ icon: Icon, title, children }: SettingsHeaderProps) {
  return (
    // Electron 下整条顶栏兼任窗口拖拽热区(titlebar-drag):header 在右侧内容区最顶,
    // 正好补窗口上方那一块可拖空间,与 chat-view 右侧顶栏同款。浏览器里这个 class
    // 是空操作,不需要门控。子级 button/a/[role='button'] 已被 index.css 的
    // .titlebar-drag 规则逐个 no-drag,点按不受影响。
    // [--mac-titlebar-inset:0px]:.titlebar-drag 默认给主页 sidebar 让出「红绿灯+折叠
    // 按钮」那条 118px;设置页 header 在 sidebar 右侧,头顶没有红绿灯,inset 归 0。
    <div
      className={`sticky top-0 z-10 flex items-center justify-between bg-background px-8 py-4 border-b border-border ${isElectron() ? "titlebar-drag [--mac-titlebar-inset:0px]" : ""
        }`}
    >
      <div className="flex items-center gap-2">
        <Icon size={20} className="text-muted-foreground" />
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      </div>
      {children}
    </div>
  );
}
