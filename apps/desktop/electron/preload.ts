const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform
  },
  // 当前应用版本(关于页)。app 模块是主进程专属,sandboxed preload 里 undefined,
  // 走 IPC 拿 —— 直接在 preload require("electron").app 会让整个 preload 崩掉。
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("get-app-version"),
  getServerPort: (): Promise<number | null> =>
    ipcRenderer.invoke("get-server-port"),
  // T33:renderer 拿 loopback token 注入 fetch/SSE。
  getServerInfo: (): Promise<{ port: number | null; token: string | null }> =>
    ipcRenderer.invoke("get-server-info"),
  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:pick-directory"),
  // eva:// 深链推送(thread 跳转 / 打开设置)。返回解绑函数。
  onDeepLink: (callback: (url: string) => void): (() => void) => {
    const listener = (_event: unknown, url: string): void => callback(url);
    ipcRenderer.on("deep-link", listener);
    return () => {
      ipcRenderer.removeListener("deep-link", listener);
    };
  },
  getAutoLaunch: (): Promise<boolean> => ipcRenderer.invoke("auto-launch:get"),
  setAutoLaunch: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("auto-launch:set", enabled),
  // T34/D1 updater:状态推送 + 手动检查/下载/安装/拉当前状态。
  updaterCheck: (): Promise<void> => ipcRenderer.invoke("updater:check"),
  updaterDownload: (): Promise<void> => ipcRenderer.invoke("updater:download"),
  updaterInstall: (): Promise<void> => ipcRenderer.invoke("updater:install"),
  getUpdaterStatus: (): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke("updater:status"),
  onUpdaterStatus: (
    callback: (status: Record<string, unknown>) => void
  ): (() => void) => {
    const listener = (_event: unknown, status: Record<string, unknown>): void =>
      callback(status);
    ipcRenderer.on("updater-status", listener);
    return () => {
      ipcRenderer.removeListener("updater-status", listener);
    };
  }
});
