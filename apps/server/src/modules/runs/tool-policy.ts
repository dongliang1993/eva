import path from "node:path";

import { classifyToolRisk } from "./tool-risk.js";
import { isSafeReadOnlyCommand } from "./safe-readonly.js";

/**
 * 工具策略 —— 从 harness 原样搬来(spec FR-010:这些判断属于 server)。
 *
 * 纯函数、无 IO;放行链(run-permissions)与 policy key 生成共用,
 * 判定源单一,两处不会漂移。
 */

export { classifyToolRisk, isSafeReadOnlyCommand };

/**
 * thread 作用域 policy key 生成器。
 *
 * 把「始终允许」从全局 per-tool 白名单细化成「这条命令 × 这个会话」。
 * 形态对齐 Alma(`main:28077-28100`):scope=`thread:<id>`,bash 产精确 key
 * `command:<cmd>` + 粗 key `:all` 两级回退;命中任一且值为 allow_always 则直放。
 *
 * 这是 policy 的**单一事实来源**:纯函数、无 IO、不读 settings、不缓存 ——
 * 一旦它开始读状态,「命中了吗」在不同调用点就会给出不同答案。
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
    // 后端也不会为它生成可记忆的 key。
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

// ─────────────────────────────────────────────── plan gate 路径判定

const normalizeInputPath = (input: string): string =>
  input.replace(/^\.\/+/, "");

const isPlanPath = (
  input: string,
  planPath: string,
  planRelPath: string,
): boolean => {
  const normalized = normalizeInputPath(input);
  if (normalized === planRelPath || normalized === normalizeInputPath(planRelPath)) {
    return true;
  }
  if (path.isAbsolute(input)) {
    return path.resolve(input) === path.resolve(planPath);
  }
  return false;
};

/** 与免弹窗短路共用的同一份路径判定（契约:planPath 单一事实源）。 */
export const matchesPlanGatePath = (
  input: string,
  snapshot: { readonly planPath?: string; readonly planRelPath?: string },
): boolean =>
  snapshot.planPath !== undefined &&
  snapshot.planRelPath !== undefined &&
  isPlanPath(input, snapshot.planPath, snapshot.planRelPath);

export const planGateDeniedMessage = (planPath: string | undefined): string =>
  `[Plan Mode] Only read-only tools and the current plan file are available. ` +
  `Write the plan to ${planPath ?? "(no plan file)"}, then call exit_plan_mode.`;
