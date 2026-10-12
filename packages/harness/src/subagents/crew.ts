import type { PipelineTool } from "../tools/index.js";

export interface SubagentRole {
  readonly type: string;
  /** 一句话，进 subagent 工具的说明让模型知道什么时候选它。 */
  readonly summary: string;
  readonly systemPrompt: string;
  /** 该角色能拿到的工具名白名单。空数组 = 不给任何工具（纯推理角色）。 */
  readonly allowedTools: readonly string[];
  readonly maxSteps?: number;
}

/**
 * 子代理单轮步数上限(独立于主 loop 的 100)。
 * 不同步到 100:子代理是无人值守的成本中心,步数闸是它的熔断器不是束缚 ——
 * 50 步跑不完的窄任务,正确动作是主 agent 拆开再派,不是让子代理硬撑。
 */
export const SUBAGENT_MAX_STEPS = 50;

/** 首批三个角色:都是"只给结论"型(上下文隔离最划算)。 */
export const SUBAGENT_ROLES: readonly SubagentRole[] = [
  {
    type: "explorer",
    summary: "读代码库回答“在哪 / 怎么实现的”",
    systemPrompt: [
      "You are a codebase explorer. Read files and search to answer a focused question.",
      "Return a concise, factual answer citing the file:line you found. Do NOT propose changes.",
      "You have no write access; never attempt to edit files.",
      "Return your final answer as text."
    ].join("\n"),
    allowedTools: ["read_file", "list_dir", "grep", "read_skill"],
  },
  {
    type: "researcher",
    summary: "查外部资料并汇合成结论",
    systemPrompt: [
      "You are a research assistant. Use web tools to gather information and synthesize.",
      "Return a concise, sourced answer. State what is uncertain.",
      "Return your final answer as text."
    ].join("\n"),
    allowedTools: ["web_search", "web_fetch", "read_file"],
  },
  {
    type: "reviewer",
    summary: "审查代码并给出问题与依据",
    systemPrompt: [
      "You are a critical reviewer. Find flaws in the given work.",
      "Return a prioritized list of issues. Do NOT write code or fixes.",
      "Return your final answer as text."
    ].join("\n"),
    allowedTools: ["read_file", "list_dir", "grep"],
  }
];

/**
 * 按角色 allowedTools 白名单过滤工具(阀4:工具集收窄)。
 * @param role 已解析的角色(装配期先 crew.get(type),拿不到就报错停摆);
 *        这里不自己查 crew —— 未知角色在解析期就该暴露,不该在过滤期静默丢工具。
 */
export const filterToolsForRole = (
  tools: readonly PipelineTool[],
  role: SubagentRole
): readonly PipelineTool[] => {
  const allowed = new Set(role.allowedTools);
  return tools.filter((t) => allowed.has(t.name));
};
/**
 * 角色声明要、但基础集里压根不存在的工具。
 *
 * 白名单是"收窄"语义,过滤不会告诉你某个工具本来就缺席。而文件工具挂在工作区守卫内 ——
 * 没绑工作区的会话里 read_file/list_dir/grep 都不存在,explorer 过滤后只剩 read_skill。
 * 那样的子代理"没有手却被要求读代码",实测会编造出看似完整的目录树。调用方据此早爆。
 */
export const missingRoleTools = (
  tools: readonly PipelineTool[],
  role: SubagentRole
): readonly string[] => {
  const present = new Set(tools.map((t) => t.name));
  return role.allowedTools.filter((name) => !present.has(name));
};
