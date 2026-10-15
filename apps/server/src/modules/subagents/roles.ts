import type { AgentDefinition, ModelBinding, PipelineTool } from "@eva/harness";

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
const SUBAGENT_MAX_STEPS = 50;

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
 * 角色声明要、但基础集里压根不存在的工具。
 *
 * 白名单是"收窄"语义,过滤不会告诉你某个工具本来就缺席。而文件工具挂在工作区守卫内 ——
 * 没绑工作区的会话里 read_file/list_dir/grep 都不存在,explorer 过滤后只剩 read_skill。
 * 那样的子代理"没有手却被要求读代码",实测会编造出看似完整的目录树。
 * subagentDefinitions 据此不列出这个角色。
 */
export const missingRoleTools = (
  tools: readonly PipelineTool[],
  role: SubagentRole
): readonly string[] => {
  const present = new Set(tools.map((t) => t.name));
  return role.allowedTools.filter((name) => !present.has(name));
};

/**
 * 子代理恒不给的工具(Claude Code 的 ALL_AGENT_DISALLOWED_TOOLS 同款):
 * plan mode 是主对话的交互状态,子代理进出 plan mode 没有人审。
 */
const SUBAGENT_DISALLOWED_TOOLS = ["enter_plan_mode", "exit_plan_mode"] as const;

/**
 * 角色 → harness 的 options.agents。
 *
 * 角色要的工具本轮不存在(没绑工作区时文件工具缺席)→ 不列出这个角色:
 * 模型看不见它,自然不会派(Claude Code 对 MCP 依赖不满足的 agent 同样不列)。
 * 之前是派发时才报错 —— "没有手却被要求读代码"的子代理会编造目录树。
 */
export const subagentDefinitions = (
  tools: readonly PipelineTool[],
  model: ModelBinding,
): Readonly<Record<string, AgentDefinition>> =>
  Object.fromEntries(
    SUBAGENT_ROLES
      .filter((role) => missingRoleTools(tools, role).length === 0)
      .map((role) => [role.type, {
        description: role.summary,
        prompt: role.systemPrompt,
        tools: role.allowedTools,
        disallowedTools: SUBAGENT_DISALLOWED_TOOLS,
        model,
        maxTurns: role.maxSteps ?? SUBAGENT_MAX_STEPS,
      } satisfies AgentDefinition]),
  );
