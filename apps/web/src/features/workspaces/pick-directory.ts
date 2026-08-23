import { apiFetch } from "../../shared/api/fetch";

export type DirectoryPick =
  | { readonly kind: "picked"; readonly path: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unavailable" };

/** Electron 壳经 preload 暴露的系统原生目录框(体验最正,优先用)。 */
export const hasElectronPicker = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.electronAPI?.pickDirectory === "function";

/**
 * 让本机 server 弹系统目录框(macOS osascript / Windows PowerShell / Linux zenity),
 * 返回选中的绝对路径。区分三种结果:选中 / 用户取消 / server 弹不出(才回落手输)。
 */
export const pickDirectoryViaServer = async (): Promise<DirectoryPick> => {
  try {
    const res = await apiFetch<{ path: string | null; unsupported?: boolean }>(
      "/api/v1/workspaces/pick-directory",
      { method: "POST" }
    );
    if (res.path) return { kind: "picked", path: res.path };
    return res.unsupported ? { kind: "unavailable" } : { kind: "cancelled" };
  } catch {
    return { kind: "unavailable" };
  }
};

/**
 * 统一的「选目录」入口:Electron IPC 优先,否则 server 弹框,都不行返回
 * unavailable 由调用方回落手输路径。取消返回 cancelled(调用方静默)。
 */
export const pickWorkspaceDirectory = async (): Promise<DirectoryPick> => {
  if (hasElectronPicker()) {
    const picked = await window.electronAPI!.pickDirectory();
    return picked ? { kind: "picked", path: picked } : { kind: "cancelled" };
  }
  return pickDirectoryViaServer();
};
