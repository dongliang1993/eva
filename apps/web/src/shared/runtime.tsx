import type { ReactNode } from "react";

/** Electron 运行时判定 —— preload 只在桌面端注入 window.electronAPI,
 *  浏览器下 undefined。titlebar-drag 等仅桌面端需要的 UI 以此门控。 */
export const isElectron = (): boolean =>
  typeof window !== "undefined" && window.electronAPI !== undefined;

/** mac 桌面壳:hiddenInset 红绿灯内嵌在窗口左上,才有「红绿灯右侧」这种专属位。
 *  Win/Linux 桌面是 titleBarStyle:"hidden"(无内嵌红绿灯),返回 false。 */
export const isMacDesktop = (): boolean =>
  isElectron() && window.electronAPI!.versions.platform === "darwin";

/** 只在 Electron(桌面壳)渲染 children —— 浏览器下输出 null。 */
export function ElectronOnly({ children }: { readonly children: ReactNode }) {
  return isElectron() ? <>{children}</> : null;
}

/** 只在浏览器渲染 children —— Electron 下输出 null。 */
export function BrowserOnly({ children }: { readonly children: ReactNode }) {
  return isElectron() ? null : <>{children}</>;
}
