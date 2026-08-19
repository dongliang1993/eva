import { ArrowLeft, Brain, Plug, Settings as SettingsIcon, Store } from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { SettingsHeader } from "./components/settings-header";
import { ResizableSidebar } from "../../shared/ui/resizable-sidebar";
import { ThemeToggle } from "../../shared/ui/theme-toggle";

const NAV_ITEMS = [
  { to: "/settings/models", label: "Models", icon: SettingsIcon },
  { to: "/settings/providers", label: "Providers", icon: Store },
  { to: "/settings/memory", label: "Memory", icon: Brain },
  { to: "/settings/mcp", label: "MCP", icon: Plug }
];

/** /settings 布局:左侧导航用 NavLink(自带 active 态),右侧 <Outlet/>。
 *  header 标题取出自当前路由(单一路由事实源)—— 直链 /settings/memory 能落在 Memory 页。 */
export function SettingsLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const current = NAV_ITEMS.find((item) => location.pathname.startsWith(item.to))
    ?? NAV_ITEMS[0]!;

  const settingsNav = (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center justify-between px-3 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            onClick={() => navigate("/chat")}
            title="Back to chat"
          >
            <ArrowLeft size={18} />
          </button>
          <span className="text-sm font-medium text-foreground">Settings</span>
        </div>
        <ThemeToggle />
      </div>

      <nav className="flex-1 px-2 py-2 space-y-1">
        {NAV_ITEMS.map((item) => {
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