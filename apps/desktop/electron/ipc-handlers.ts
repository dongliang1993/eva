// IPC Handlers:与 preload.ts 暴露的 electronAPI 一一对应,按 namespace 分组。
//
// 这里只做「把 renderer 的请求转给对应 owner」,不持有任何状态 ——
// 端口/token 问 server-supervisor,窗口问 window-manager,更新问 updater。
import { app, dialog, ipcMain } from "electron";

import { getServerInfo, getServerPort, killServer } from "./server-supervisor";
import { checkForUpdates, downloadUpdate, getUpdaterStatus, installUpdate } from "./updater";
import { getMainWindow } from "./window-manager";

export const registerIpcHandlers = (): void => {
  ipcMain.handle("get-server-port", () => getServerPort());
  // app 模块在 sandboxed preload 里拿不到(主进程专属),版本号走 IPC。
  ipcMain.handle("get-app-version", () => app.getVersion());

  // T33:renderer 拿 loopback token 注入 fetch/SSE 的 x-eva-token。
  ipcMain.handle("get-server-info", () => getServerInfo());

  ipcMain.handle("dialog:pick-directory", async (): Promise<string | null> => {
    const parent = getMainWindow();

    if (!parent) {
      return null;
    }

    const result = await dialog.showOpenDialog(parent, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择工作区目录"
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // 自启动(macOS LaunchAgent / Windows Run 注册表)。openAsHidden 只 mac 有效。
  ipcMain.handle("auto-launch:get", () => app.getLoginItemSettings().openAtLogin);

  ipcMain.handle("auto-launch:set", (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return app.getLoginItemSettings().openAtLogin;
  });

  // T34 updater:renderer 手动检查 / 下载(D1) / 确认安装 / 拉当前状态(补启动时错过的广播)。
  ipcMain.handle("updater:check", () => checkForUpdates());
  ipcMain.handle("updater:download", () => downloadUpdate());
  // D7:安装前先收 server(及其 MCP 子进程)——驻留进程会锁住安装目录导致
  // ShipIt 换包失败(Cindy adb 教训,23 篇 §4 D7)。before-quit 里的 killServer 是双保险。
  ipcMain.handle("updater:install", () => {
    killServer();
    installUpdate();
  });
  ipcMain.handle("updater:status", () => getUpdaterStatus());
};
