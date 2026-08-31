// 用户 shell 环境(borrowed from CodePilot)。
// 只有一个消费者:server-supervisor fork server 时把它注入子进程 env。
import { execFileSync } from "node:child_process";

/**
 * Read the user's full shell environment by running a login shell.
 * When Electron is launched from Dock (macOS), process.env is very limited
 * and won't include vars from .zshrc/.bashrc (e.g. API keys).
 */
export function loadUserShellEnv(): Record<string, string> {
  if (process.platform === "win32") {
    return {};
  }

  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const result = execFileSync(shell, ["-ilc", "env"], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });

    const env: Record<string, string> = {};

    for (const line of result.split("\n")) {
      const idx = line.indexOf("=");

      if (idx > 0) {
        env[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }

    console.log(`[env] Loaded ${Object.keys(env).length} vars from user shell`);

    return env;
  } catch (err) {
    console.warn("[env] Failed to load user shell env:", err);

    return {};
  }
}
