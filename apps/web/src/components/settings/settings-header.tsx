import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface SettingsHeaderProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly children?: ReactNode;
}

export function SettingsHeader({ icon: Icon, title, children }: SettingsHeaderProps) {
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between bg-background px-8 py-4 border-b border-border">
      <div className="flex items-center gap-2">
        <Icon size={20} className="text-muted-foreground" />
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      </div>
      {children}
    </div>
  );
}
