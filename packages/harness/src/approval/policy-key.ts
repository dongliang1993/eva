import { classifyToolRisk } from "../tools/risk.js";

/**
 * thread 作用域 policy key 生成器(T27,方案 docs/architecture/22 §3.1)。
 *
 * 把「始终允许」从全局 per-tool 白名单细化成「这条命令 × 这个会话」。
 * 形态对齐 Alma(`main:28077-28100`):scope=`thread:<id>`,bash 产精确 key
 * `command:<cmd>` + 粗 key `:all` 两级回退;命中任一且值为 allow_always 则直放。
 *
 * 单一事实来源(r7 §3 契约 1):纯函数、无 IO、不读 settings、不缓存。
 */

export interface PolicyKeyInput {
  /** 工具名:"bash" | "write" | "edit" | "mcp__xxx__yyy" | ... */
  toolName: string;
  /** 当前会话(thread)id。调用方保证非空。 */
  threadId: string;
  args: Record<string, unknown>;
}

/**
 * 生成候选 policy key,精确在前、粗放在后。
 * 返回空数组 = 该调用不可记忆(destructive 双保险 / 只读或未知工具)。
 */
export const buildPolicyKeys = (input: PolicyKeyInput): string[] => {
  const scope = `thread:${input.threadId}`;

  if (input.toolName === "bash") {
    const command = typeof input.args.command === "string" ? input.args.command.trim() : "";
    // 双保险:destructive 永不进 policy。即便有人手改 settings 写入,
    // 后端也不会为它生成可记忆的 key(r7 §4.3)。
    if (command && classifyToolRisk("bash", { command }).level === "destructive") {
      return [];
    }
    const keys = command ? [`bash:${scope}:command:${command}`] : [];
    keys.push(`bash:${scope}:all`);
    return keys;
  }

  if (input.toolName === "write" || input.toolName === "edit") {
    return [`${input.toolName}:${scope}:all`];
  }

  if (input.toolName.startsWith("mcp__")) {
    return [`mcp:${scope}:tool:${input.toolName}`, `mcp:${scope}:all`];
  }

  return [];
};
