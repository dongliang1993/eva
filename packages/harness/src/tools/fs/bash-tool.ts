import { spawn } from "node:child_process";
import { z } from "zod";

import {
  buildTool,
  TOOL_CALL_ABORTED_OUTPUT,
  type AgentTool,
  type ToolExecutionOptions,
} from "../build-tool.js";
import type { FsToolBaseOptions } from "./read-file-tool.js";
import { maybeOverflow } from "./tool-overflow.js";

const bashSchema = z.object({
  command: z.string().describe("Shell command to run within the workspace."),
  description: z
    .string()
    .describe(
      "Clear, concise description of what this command does in active voice, 5-10 words " +
        '(shown in the UI as the row title). Examples: "ls" → "List files in current directory"; ' +
        '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
    ),
});

/** 兜底超时:命令自身没有退出机制时,到点强制结束。 */
const BASH_TIMEOUT_MS = 120_000;
/** SIGTERM 后子进程仍未退出的宽限期,到点补 SIGKILL(两段式)。 */
const KILL_GRACE_MS = 2_000;
/** 空闲 IO 缓冲告警阈值:超过则视为失控输出,杀掉避免 maxBuffer 无界累积。 */
const IO_IDLE_KILL_MS = 10_000;

interface BashResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly canceled: boolean;
  readonly timeout: boolean;
}

/**
 * T25:用 spawn + detached 让 bash 自成进程组 —— 取消时 kill(-pid) 组杀,
 * 否则 bash 不给子孙进程转发 SIGTERM(`sleep 10 && echo x` 里 sleep 会变孤儿,
 * 实测 execFile 的 detached 不生效、pgid 仍挂在父进程组,组杀会 ESRCH)。
 * SIGTERM 先行(给 trap/清理钩子机会),宽限期后 SIGKILL 兜底;
 * 不直接 SIGKILL:跳过子进程清理且丢掉输出缓冲,排查变盲。
 * 输出用 idle-timer 看护:有数据流入就续命,静默超过 IO_IDLE_KILL_MS 才判
 * 失控 —— 单纯看输出总量会误杀 build/日志类工具。
 */
const runBash = (
  command: string,
  options: FsToolBaseOptions,
  abortSignal?: AbortSignal,
): Promise<BashResult> =>
  new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: options.workRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    // 结束原因,决定 resolve 语义;同一时刻只可能有一个为 true。
    let canceled = false;
    let timedOut = false;

    const clearTimeouts = () => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    };
    const removeAbortListener = () => {
      if (abortSignal !== undefined)
        abortSignal.removeEventListener("abort", onAbort);
    };
    const cleanup = () => {
      clearTimeouts();
      removeAbortListener();
    };
    /** 组杀 SIGTERM;宽限期后补 SIGKILL(两段式)。 */
    const killTree = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // 进程组已不在(可能已退出)—— 对 pid 本身再补一次,双保险。
        child.kill("SIGTERM");
      }
      killTimer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
    };
    const settle = (result: BashResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      canceled = true;
      killTree();
    };

    if (abortSignal !== undefined) {
      if (abortSignal.aborted) {
        canceled = true;
        killTree();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      armIdleTimer();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      armIdleTimer();
    });
    child.on("error", (error) => {
      settle({
        stdout,
        stderr: `${stderr}\n${error.message}`,
        canceled,
        timeout: false,
      });
    });
    // 退出码语义:显式 0/非 0 是正常路径(输出原样回给模型);取消/超时由
    // canceled/timedOut 标记决定文案;spawn 失败走 error 事件。
    child.on("exit", () => {
      settle({ stdout, stderr, canceled, timeout: timedOut });
    });

    const armIdleTimer = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, IO_IDLE_KILL_MS);
    };
    armIdleTimer();

    // 兜底超时:与 idle 分开计时,命令总时长超限即杀。
    setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killTree();
    }, BASH_TIMEOUT_MS);
  });

export const createBashTool = (options: FsToolBaseOptions): AgentTool =>
  buildTool({
    name: "bash",
    description:
      "Run a shell command within the workspace root. Requires user approval " +
      "because it can modify files or have side effects.",
    inputSchema: bashSchema,
    needsApproval: true,
    async execute({ command }, execOptions?: ToolExecutionOptions) {
      const { stdout, stderr, canceled, timeout } = await runBash(
        command,
        options,
        execOptions?.abortSignal,
      );
      if (canceled) {
        return TOOL_CALL_ABORTED_OUTPUT;
      }
      if (timeout) {
        return maybeOverflow(
          `Exit: SIGTERM\n(command exceeded its time limit)\n${[stdout, stderr].filter(Boolean).join("\n")}`,
          options.overflowDir ?? "",
          "bash",
        );
      }
      const all = [stdout, stderr].filter(Boolean).join("\n");
      return maybeOverflow(all, options.overflowDir ?? "", "bash");
    },
  });
