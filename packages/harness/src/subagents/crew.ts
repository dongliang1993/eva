import type { AgentTool } from "../tools.js";

export interface SubagentRole {
  readonly type: string;
  /** 一句话，进 Task 工具的 description 让模型知道什么时候选它。 */
  readonly summary: string;
  readonly systemPrompt: string;
  /** 该角色能拿到的工具名白名单。空数组 = 不给任何工具（纯推理角色）。 */
  readonly allowedTools: readonly string[];
  /** 能再委派给哪些角色。空数组 = 拿不到 Task 工具，无法套娃。 */
  readonly allowedDelegates: readonly string[];
  readonly maxSteps?: number;
}

/**
 * 委派深度上限。主 loop = 0 → 一层专家(reviewer) → 一层助手(explorer) = 2。
 * 再深就该拆任务而不是套娃 —— 每加深一层,主上下文省下的都被嵌套上下文重吃回去。
 * 这是 docs 08 §6.2 的递归版本的第四条边(depth + 1 > MAX_DEPTH 即拒)。
 */
export const MAX_DEPTH = 2;

/** TaskOutput join 的硬上限。子代理死循环时主 agent 不能植物人(docs 08 坑②)。 */
export const JOIN_TIMEOUT_MS = 120_000;

/** 子代理单轮步数上限(独立于主 loop 的 25)。 */
export const SUBAGENT_MAX_STEPS = 20;

/** 首批三个角色:都是"只给结论"型(上下文隔离最划算)。 */
const BUILTIN_ROLES: readonly SubagentRole[] = [
  {
    type: "explorer",
    summary: "读代码库回答“在哪 / 怎么实现的”",
    systemPrompt: [
      "You are a codebase explorer. Read files and search to answer a focused question.",
      "Return a concise, factual answer citing the file:line you found. Do NOT propose changes.",
      "You have no write access; never attempt to edit files."
    ].join("\n"),
    allowedTools: ["read_file", "list_dir", "grep", "read_skill"],
    allowedDelegates: // explorer 不委派 —— 已是叶子
      []
  },
  {
    type: "researcher",
    summary: "查外部资料并汇合成结论",
    systemPrompt: [
      "You are a research assistant. Use web tools to gather information and synthesize.",
      "Return a concise, sourced answer. State what is uncertain."
    ].join("\n"),
    allowedTools: ["web_search", "web_fetch", "read_file"],
    allowedDelegates: []
  },
  {
    type: "reviewer",
    summary: "挑毛病但不给实现,可委派 explorer 复核",
    systemPrompt: [
      "You are a critical reviewer. Find flaws in the given work.",
      "You may delegate `explorer` to check specific claims against the code.",
      "Return a prioritized list of issues. Do NOT write code or fixes."
    ].join("\n"),
    allowedTools: ["read_file", "list_dir", "grep"],
    allowedDelegates: ["explorer"]
  }
];

/** 角色表。可对外注册自定义角色(先 buildIn,后 register 覆盖同名)。 */
export class CrewRegistry {
  private readonly roles = new Map<string, SubagentRole>(
    BUILTIN_ROLES.map((r) => [r.type, r])
  );

  get(type: string): SubagentRole | undefined {
    return this.roles.get(type);
  }

  /** 覆盖式注册:同名角色替换内置,便于测试与扩展。 */
  register(role: SubagentRole): void {
    this.roles.set(role.type, role);
  }

  list(): readonly SubagentRole[] {
    return [...this.roles.values()];
  }
}

/** 内置 crew(测试与默认装配用同一个实例的形状,不共享实例以免测试污染)。 */
export const BUILTIN_CREW = new CrewRegistry();

/**
 * 按角色 allowedTools 白名单过滤工具(阀4:工具集收窄)。
 * @param role 已解析的角色(装配期先 crew.get(type),拿不到就报错停摆);
 *        这里不自己查 crew —— 未知角色在解析期就该暴露,不该在过滤期静默丢工具。
 */
export const filterToolsForRole = (
  tools: readonly AgentTool[],
  role: SubagentRole
): readonly AgentTool[] => {
  const allowed = new Set(role.allowedTools);
  return tools.filter((t) => allowed.has(t.name));
};

/** 委派白名单(阀3a):current 能否派 target。未知 current → false(保守)。 */
export const canDelegate = (current: string, target: string): boolean => {
  const role = BUILTIN_CREW.get(current);
  if (role === undefined) {
    return false;
  }
  return role.allowedDelegates.includes(target);
};

/** 深度闸(阀3b):当前 depth 能否再 spawn 一层。depth+1 > MAX_DEPTH 即拒。 */
export const canSpawnAtDepth = (currentDepth: number): boolean =>
  currentDepth + 1 <= MAX_DEPTH;
