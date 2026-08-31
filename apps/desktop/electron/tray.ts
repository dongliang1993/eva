// 托盘与全局快捷键:两个 OS 级「唤起主窗」入口,同一时机注册(主窗创建后)。
// 二者都只调 window-manager 的 focus/toggle —— 判断窗口死活的逻辑不在这里复制一份。
import { app, globalShortcut, Menu, nativeImage, Tray } from "electron";
import path from "node:path";

import { requestQuit } from "./app-lifecycle";
import { focusMainWindow, getMainWindow, toggleMainWindow } from "./window-manager";

let tray: Tray | null = null;

export function createTray(): void {
  // Template Image:mac 托盘自动适配明暗。图标源是纯色 icon.png 的 16px 缩版,
  // 有正式 logo 后替换 build/iconTemplate.png 即可。
  const iconPath = path.join(__dirname, "..", "build", "iconTemplate.png");
  let image = nativeImage.createFromPath(iconPath);

  if (image.isEmpty()) {
    // dev 时 build/ 可能不在 dist-electron 旁,退回 app 根
    image = nativeImage.createFromPath(
      path.join(app.getAppPath(), "build", "iconTemplate.png")
    );
  }

  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }

  tray = new Tray(image);
  tray.setToolTip("Eva");

  const menu = Menu.buildFromTemplate([
    { label: "显示 Eva", click: () => focusMainWindow() },
    {
      label: "设置",
      click: () => {
        focusMainWindow();
        getMainWindow()?.webContents.send("deep-link", "eva://settings");
      }
    },
    { type: "separator" },
    {
      label: "退出 Eva",
      click: () => requestQuit()
    }
  ]);

  tray.setContextMenu(menu);
  tray.on("click", () => focusMainWindow());
}

export function registerGlobalShortcut(): void {
  const ok = globalShortcut.register("Alt+Space", toggleMainWindow);

  if (!ok) {
    // 被别的 app 占了 —— 降级,不致命,托盘/程序坞仍可用。
    console.warn("[shortcut] Alt+Space 注册失败(可能被占用),已跳过");
  }
}
