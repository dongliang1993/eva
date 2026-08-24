import { ArrowLeft, Brain, Info, Plug, Settings as SettingsIcon, ShieldCheck, Store } from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { SettingsHeader } from "./components/settings-header";
import { ResizableSidebar } from "../../shared/ui/resizable-sidebar";
import { isElectron, isMacDesktop } from "../../shared/runtime";

const NAV_ITEMS = [
  { to: "/settings/models", label: "通用", icon: SettingsIcon },
  { to: "/settings/providers", label: "提供商", icon: Store },
  { to: "/settings/memory", label: "记忆", icon: Brain },
  { to: "/settings/security", label: "Security", icon: ShieldCheck },
  { to: "/settings/mcp", label: "MCP", icon: Plug }
];

/** 关于页只活在桌面壳里(版本号与更新都走 Electron IPC),浏览器没有这条。 */
const ABOUT_ITEM = { to: "/settings/about", label: "关于", icon: Info };

/** /settings 布局:左侧导航用 NavLink(自带 active 态),右侧 <Outlet/>。
 *  header 标题取出自当前路由(单一路由事实源)—— 直链 /settings/memory 能落在 Memory 页。 */
export function SettingsLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const items = isElectron() ? [...NAV_ITEMS, ABOUT_ITEM] : NAV_ITEMS;
  const current = items.find((item) => location.pathname.startsWith(item.to))
    ?? NAV_ITEMS[0]!;

  const settingsNav = (
    <div className="flex h-full flex-col bg-sidebar">
      {/* mac 桌面壳是 hiddenInset:红绿灯内嵌在窗口左上,会盖住顶部的返回按钮。
          与主页 sidebar 同款占位,把内容压到红绿灯下面。Win/Linux 是 hidden
          (无内嵌红绿灯),不留这段死空间。 */}
      {isMacDesktop() ? (
        <div className="titlebar-drag h-[42px] w-full shrink-0" />
      ) : null}

      <div className="flex items-center justify-between px-2 py-1">
        <button
          type="button"
          className="flex items-center gap-2 px-3 py-2 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors w-full"
          onClick={() => navigate("/chat")}
          title="返回聊天"
        >
          <ArrowLeft size={18} />
          <span className="text-sm font-medium text-foreground">设置</span>
        </button>
      </div>

      <nav className="flex-1 px-2 py-2 space-y-1">
        {items.map((item) => {
          const Icon = item.icon;

          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex w-full items-center gap-2.5 rounded-md px-3.5 py-2 text-sm transition-colors ${isActive
                  ? "bg-sidebar-active text-sidebar-active-foreground font-medium"
                  : "text-foreground hover:bg-accent"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={16} className={isActive ? "text-primary" : "text-muted-foreground"} />
                  <span>{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );

  return (
    <div className="h-full">
      <ResizableSidebar sidebar={settingsNav}>
        <div className="flex-1 flex flex-col min-h-0 h-full bg-background">
          <SettingsHeader icon={current.icon} title={current.label} />
          <div className="flex-1 overflow-y-hidden px-8 py-6">
            <Outlet />
          </div>
        </div>
      </ResizableSidebar>
    </div>
  );
}