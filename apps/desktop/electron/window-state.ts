// 窗口尺寸/位置记忆。事实源是 userData/window-state.json,唯一 owner 是本文件;
// window-manager 只在建窗时读一次、在 close 时写一次。
import { app, BrowserWindow, screen } from "electron";
import fs from "node:fs";
import path from "node:path";

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

const DEFAULT_WINDOW_STATE: WindowState = { width: 1200, height: 800 };

function getWindowStatePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

export function readWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), "utf-8");
    const s = JSON.parse(raw) as WindowState;

    // 上次的坐标可能落在已拔掉的副屏上 —— 恢复前校验还在当前某块屏内,否则丢回默认居中。
    if (typeof s.x === "number" && typeof s.y === "number") {
      const onScreen = screen.getAllDisplays().some((d) => {
        const { x, y, width, height } = d.workArea;
        return (
          s.x! >= x - 8 &&
          s.y! >= y - 8 &&
          s.x! < x + width &&
          s.y! < y + height
        );
      });

      if (!onScreen) {
        delete s.x;
        delete s.y;
      }
    }

    return { ...DEFAULT_WINDOW_STATE, ...s };
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

export function writeWindowState(win: BrowserWindow): void {
  try {
    const isMaximized = win.isMaximized();
    // 最大化时 bounds 是满屏,存进去下次恢复不出正常尺寸 —— 取 normal bounds。
    const b = win.getNormalBounds();
    const state: WindowState = {
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      isMaximized
    };
    fs.mkdirSync(path.dirname(getWindowStatePath()), { recursive: true });
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state));
  } catch (err) {
    console.warn("[window-state] Failed to write:", err);
  }
}
