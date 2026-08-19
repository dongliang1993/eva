import type { ToolRisk } from "@eva/shared";

/**
 * 危险工具调用的风险画像。纯函数、无 IO —— 它只看工具名与入参。
 *
 * 为什么放 harness:工具是 harness 定义的,"哪些参数形态是危险的"属于工具知识。
 * 服务端在发 approval_request 事件时调它,把结果附在事件上。
 *
 * 不做命令解析。用正则匹配形态,宁可误报(多标一个 destructive)也不漏报。
 * 产出只用于**给用户看**,不用于自动拒绝 —— 误报的代价只是多看一眼。
 * 真正的安全边界是 resolveWorkspacePath 的路径沙盒与审批本身,不是这里。
 */

/**
 * bash 的 dangerous 形态。每个都要注释"为什么危险"。
 * 破坏性形态(rm 递归强制删除 / 提权 / 不可逆 git / 下载即执行 / fork bomb)
 * 优先判定 —— 命中任意一条即 destructive,否则降到 elevated。
 */
const bashDestructiveReasons = (cmd: string): readonly string[] => {
  const reasons: string[] = [];

  // 递归强制删除:rm 同时带 recursive 与 force。逐 flag 判,兼容短结合(-rf)与长选项。
  // 只匹配 `rm` 后紧跟的 flag 段(到第一个非选项目标为止),避免 `rm -f file` 单用误报。
  const rm = cmd.match(/\brm\b((?:\s+--?[a-zA-Z]+)+)/);
  if (rm) {
    const flagTokens = rm[1]!.trim().split(/\s+/).map((t) => t.replace(/^--/, "--"));
    const isShort = (t: string): boolean => t.startsWith("-") && !t.startsWith("--");
    const isLong = (t: string): boolean => t.startsWith("--");
    // 短 flag:按字符判;长 flag:按词判。
    const parseFlag = (t: string): { rec: boolean; force: boolean } => {
      if (isShort(t)) {
        const chars = t.slice(1);
        return {
          rec: /[rR]/.test(chars),
          force: /[fF]/.test(chars)
        };
      }
      if (isLong(t)) {
        return {
          rec: t === "--recursive",
          force: t === "--force"
        };
      }
      return { rec: false, force: false };
    };
    const flags = flagTokens.map(parseFlag);
    if (flags.some((f) => f.rec) && flags.some((f) => f.force)) {
      reasons.push("递归强制删除");
    }
  }

  // 提权/改权限:sudo / chmod 危险权限位 / chown。
  if (/\bsudo\b/.test(cmd)) reasons.push("以 sudo 提权执行");
  if (/\bchmod\b\s+[0-7]*[0-7][0-7]?\b/.test(cmd)) reasons.push("chmod 改为危险权限位");
  if (/\bchown\b/.test(cmd)) reasons.push("chown 改文件属主");

  // 不可逆的 git 操作:强制推送 / 硬重置。
  if (/git\s+(?:push\s+(?:--force|-f)|reset\s+--hard)\b/.test(cmd)) {
    reasons.push("不可逆的 git 操作");
  }

  // 下载即执行:curl/wget 管道进 shell。
  if (/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/.test(cmd)) {
    reasons.push("下载并直接执行");
  }

  // fork bomb 形态。
  if (/:\(\)\{/.test(cmd)) reasons.push("fork bomb");

  return reasons;
};

/** bash 的 elevated 形态:覆盖写入已存在文件(重定向 `>` 到路径)。 */
const bashElevatedReasons = (cmd: string): readonly string[] => {
  const reasons: string[] = [];

  // 覆盖写入:`> 路径`(排除追加 `>>` 与 fd 重定向 `2>`)。危险在覆盖已有文件。
  // `>` 后可带空格也可不带(`> file` / `>file`)。
  if (/(?:\s|^)>(?!>)\s*\S+/.test(cmd)) reasons.push("覆盖写入到文件");

  return reasons;
};

/** bash:无论如何至少 elevated;命中破坏性形态则升到 destructive。 */
const classifyBash = (args: Record<string, unknown>): ToolRisk => {
  const cmd = typeof args.command === "string" ? args.command.trim() : "";

  const destructive = bashDestructiveReasons(cmd);
  if (destructive.length > 0) {
    return { level: "destructive", reasons: destructive };
  }

  const elevated = bashElevatedReasons(cmd);
  return {
    level: "elevated",
    reasons: [...elevated, "bash 命令本身可修改文件或产生副作用"]
  };
};

/**
 * 给一次工具调用打风险标签。unknown 工具/只读工具默认 normal(不误报)。
 */
export const classifyToolRisk = (
  toolName: string,
  args: Record<string, unknown>
): ToolRisk => {
  if (toolName === "bash") return classifyBash(args);

  // write / edit 修改文件系统 → elevated(真正的路径边界由 resolveWorkspacePath 守)。
  if (toolName === "write" || toolName === "edit") {
    return { level: "elevated", reasons: ["修改文件(write/edit 属危险工具)"] };
  }

  // 其它工具(只读、搜索、MCP)不做形态分类 → normal。
  return { level: "normal", reasons: [] };
};