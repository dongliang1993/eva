/** Electron 运行时判定 —— preload 只在桌面端注入 window.electronAPI,
 *  浏览器下 undefined。titlebar-drag 等仅桌面端需要的 UI 以此门控。 */
export const isElectron = (): boolean =>
  typeof window !== "undefined" && window.electronAPI !== undefined;
