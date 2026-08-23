/**
 * T39:工具数安全网(Alma PM-011,main:90600-90606)。
 *
 * 未显式设 activeTools 时,工具总数 > TOOL_COUNT_SAFETY_LIMIT 退化到最小集 +
 * 发 tool_count_degraded —— 防 MCP 接满后工具爆炸(token 成本 + 选择困难)。
 * 显式设了 activeTools 就尊重(显式选择优先于安全网),哪怕 >40 也不钳。
 */
import type { AgentTool } from "../tools/index.js";

/** Alma PM-011:工具数超过此值且未显式设 activeTools 时退化。 */
export const TOOL_COUNT_SAFETY_LIMIT = 40;

/**
 * 最小集:对话不爆炸所必需的 coding 命脉(fs 读写 + bash)。
 * 宁小勿大 —— memory/web-* 这类「锦上添花」在超限时让位(丢了对话还能跑,
 * fs/bash 丢了 coding agent 就废了)。只留实际存在的(交集),不臆造缺席的。
 */
const MINIMAL_TOOL_NAMES: readonly string[] = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "bash",
];

export interface ToolSafetyNetResult {
  tools: Map<string, AgentTool>;
  /** true = 触发了超限退化(调用方应发 tool_count_degraded + warning)。 */
  degraded: boolean;
}

/**
 * 工具数 > limit 且未设 activeToolNames → 退化到最小集。
 *
 * 1. 显式设了 activeToolNames → 按它过滤(尊重上游选择),degraded=false;
 * 2. 没设且数量 ≤ limit → 原样,degraded=false;
 * 3. 没设且数量 > limit → 退化到 MINIMAL_TOOL_NAMES ∩ 实际存在,degraded=true。
 */
export const applyToolCountSafetyNet = (
  tools: ReadonlyMap<string, AgentTool>,
  activeToolNames?: readonly string[],
): ToolSafetyNetResult => {
  // 显式选择优先:照单过滤(只留实际存在的),不钳数量。
  if (activeToolNames !== undefined) {
    const filtered = new Map<string, AgentTool>();
    for (const name of activeToolNames) {
      const tool = tools.get(name);
      if (tool) filtered.set(name, tool);
    }
    return { tools: filtered, degraded: false };
  }

  if (tools.size <= TOOL_COUNT_SAFETY_LIMIT) {
    return { tools: new Map(tools), degraded: false };
  }

  const minimal = new Map<string, AgentTool>();
  for (const name of MINIMAL_TOOL_NAMES) {
    const tool = tools.get(name);
    if (tool) minimal.set(name, tool);
  }
  return { tools: minimal, degraded: true };
};
