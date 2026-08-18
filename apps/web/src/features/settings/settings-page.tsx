import { useState } from "react";
import { Settings as SettingsIcon, Store, ArrowLeft, Brain } from "lucide-react";

import { GeneralSettings } from "./components/general-settings";
import { MemorySettings } from "./components/memory-settings";
import { ProviderSettings } from "./components/provider-settings";
import { SettingsHeader } from "./components/settings-header";
import { ResizableSidebar } from "../../shared/ui/resizable-sidebar";

interface SettingsPageProps {
  onBack: () => void;
}

const NAV_ITEMS = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "providers", label: "Providers", icon: Store },
  { id: "memory", label: "Memory", icon: Brain }
] as const;

type NavId = (typeof NAV_ITEMS)[number]["id"];

export function SettingsPage({ onBack }: SettingsPageProps) {
  const [activeNav, setActiveNav] = useState<NavId>("general");

  const settingsNav = (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center gap-2 px-3 py-3">
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          onClick={onBack}
          title="Back to chat"
        >
          <ArrowLeft size={18} />
        </button>
        <span className="text-sm font-medium text-foreground">Settings</span>
      </div>

      <nav className="flex-1 px-2 py-2 space-y-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeNav === item.id;

          return (
            <button
              key={item.id}
              type="button"
              className={`flex w-full items-center gap-2.5 rounded-md px-3.5 py-2 text-sm transition-colors ${isActive
                ? "bg-sidebar-active text-sidebar-active-foreground font-medium"
                : "text-foreground hover:bg-accent"
                }`}
              onClick={() => setActiveNav(item.id)}
            >
              <Icon size={16} className={isActive ? "text-primary" : "text-muted-foreground"} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );

  return (
    <div className="h-full">
      <ResizableSidebar sidebar={settingsNav}>
        <div className="flex-1 flex flex-col min-h-0 h-full bg-background">
          <SettingsHeader
            icon={NAV_ITEMS.find((n) => n.id === activeNav)!.icon}
            title={NAV_ITEMS.find((n) => n.id === activeNav)!.label}
          />
          <div className="flex-1 overflow-y-hidden px-8 py-6">
            {activeNav === "general" ? <GeneralSettings /> : null}
            {activeNav === "providers" ? <ProviderSettings /> : null}
            {activeNav === "memory" ? <MemorySettings /> : null}
          </div>
        </div>
      </ResizableSidebar>
    </div>
  );
}
