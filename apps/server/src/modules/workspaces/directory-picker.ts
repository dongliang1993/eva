import { execFile } from "node:child_process";

/** 选目录弹框的超时 —— 用户可能停在框上很久,给足 5 分钟。 */
const PICK_TIMEOUT_MS = 5 * 60 * 1000;

export interface PickDirectoryResult {
  /** 选中的绝对路径;用户取消为 null。 */
  readonly path: string | null;
  /** 当前平台不支持原生弹框时为 true(前端应回落手输)。 */
  readonly unsupported?: boolean;
}

/** 子进程执行结果(退出码 + 输出),便于测试注入 fake。 */
export interface ExecOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecFn = (cmd: string, args: readonly string[]) => Promise<ExecOutcome>;

const realExec: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { timeout: PICK_TIMEOUT_MS }, (error, stdout, stderr) => {
      // execFile 的 error 在「进程非零退出」和「启动失败/超时」都会给,这里把退出
      // 码与输出一并带回去,由调用方区分「用户取消」和「真出错」。
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({
        code: typeof error?.code === "number" ? error.code : 0,
        stdout: String(stdout),
        stderr: String(stderr)
      });
    });
  });

const isCancel = (stderr: string): boolean =>
  // macOS: 用户已取消 / User canceled (-128);Windows: 空输出零退出由调用方判 null;
  // Linux zenity: 取消非零退出且 stderr 为空/含 "cancelled"。
  /canceled|cancelled|已取消|\(-128\)/i.test(stderr);

/**
 * 本机原生目录选择框。Eva 的 server 跑在本机(loopback),所以由 server 弹系统框
 * 拿到绝对路径返回给前端 —— 浏览器 / Electron 渲染层都受益,不必手输路径。
 *
 * 平台策略(首版):macOS 用 osascript `choose folder`(原生、带 New Folder);
 * Windows 用 PowerShell FolderBrowserDialog;Linux 用 zenity(若装有)。
 * 不支持 / 弹不出 → 抛错,路由层转为 unsupported 让前端回落。
 *
 * exec 可注入(测试用);platform 可覆盖以走其它分支。
 */
export const pickDirectory = async (
  exec: ExecFn = realExec,
  platform: NodeJS.Platform = process.platform
): Promise<PickDirectoryResult> => {
  switch (platform) {
    case "darwin": {
      const { code, stdout, stderr } = await exec("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "Select Workspace Directory")'
      ]);
      if (code !== 0) {
        if (isCancel(stderr)) return { path: null };
        throw new Error(`osascript failed: ${stderr.trim() || code}`);
      }
      // osascript 的 POSIX path 带尾 "/",去掉;空输出视为取消。
      const path = stdout.trim().replace(/\/+$/, "");
      return { path: path || null };
    }

    case "win32": {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms;" +
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog;" +
        "$d.Description = 'Select Workspace Directory';" +
        "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }";
      const { code, stdout, stderr } = await exec("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script
      ]);
      if (code !== 0) throw new Error(`powershell failed: ${stderr.trim() || code}`);
      const path = stdout.trim();
      return { path: path || null };
    }

    case "linux": {
      const { code, stdout, stderr } = await exec("zenity", [
        "--file-selection",
        "--directory",
        "--title=Select Workspace Directory"
      ]);
      if (code !== 0) {
        if (isCancel(stderr) || stderr.trim() === "") return { path: null };
        throw new Error(`zenity failed: ${stderr.trim() || code}`);
      }
      const path = stdout.trim();
      return { path: path || null };
    }

    default:
      return { path: null, unsupported: true };
  }
};
