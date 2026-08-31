// App Lifecycle:单实例锁 + 进程退出语义。
//
// isQuitting 是这里唯一的状态:mac 关窗留进程(托盘可再唤起),只有「真的要退出」时
// 才收 server。托盘的「退出 Eva」与 before-quit 都必须经 requestQuit,否则
// window-all-closed 会把一次真退出误判成一次关窗。
import { app, BrowserWindow, globalShortcut } from "electron";

import { handleDeepLink } from "./protocol-handler";
import { getServerPort, killServer } from "./server-supervisor";
import { focusMainWindow } from "./window-manager";

let isQuitting = false;

// 托盘菜单「退出 Eva」的唯一出口:先置 isQuitting,window-all-closed 才会收 server。
export const requestQuit = (): void => {
  isQuitting = true;
  app.quit();
};

export const enforceSingleInstance = (): void => {
  // 第二个实例会抢同一个 ~/.eva/eva.db —— SQLite WAL 能扛并发读写,但两个实例
  // 各自 fork 一份 server、各自连一套 MCP server,行为不可预测。直接拒绝第二实例,
  // 把深链 argv 转给已跑的实例。
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on("second-instance", (_event, argv) => {
      focusMainWindow();
      // Windows/Linux 深链走 argv;mac 走 open-url,不在这里。
      const deepLink = argv.find((a) => a.startsWith("eva://"));
      if (deepLink) {
        handleDeepLink(deepLink);
      }
    });
  }
};

export const registerAppLifecycle = (): void => {
  app.on("window-all-closed", () => {
    // mac 惯例:关窗留进程(托盘可再唤起)。托盘「退出 Eva」会先置 isQuitting。
    if (process.platform !== "darwin" || isQuitting) {
      killServer();
      app.quit();
    }
  });

  app.on("activate", () => {
    // 点 Dock 图标:没窗就重建(focusMainWindow 内部已处理 destroyed 重建 + show)。
    if (BrowserWindow.getAllWindows().length === 0 && getServerPort()) {
      focusMainWindow();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    killServer();
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });
};
