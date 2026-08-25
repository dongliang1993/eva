import type { AgentTool } from "../tools/index.js";

/** Alma PM-011:工具数超过此值且未显式设 activeTools 时进入 discovery mode。 */
export const TOOL_COUNT_SAFETY_LIMIT = 40;

/** discovery mode 下允许通过 tool_search 激活的总量上限,防多轮搜索把 activeTools 重新撑爆。 */
export const MAX_DISCOVERY_ACTIVATED_TOOLS = 24;

/**
 * 超限首步仍暴露的核心工具。coding 命脉(fs/bash) + skill 正文入口 + 发现入口。
 * 只留实际存在的(交集),不臆造缺席的。
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  "tool_search",
  "read_skill",
  "read_file",
  "list_dir",
  "grep",
  "write_file",
  "edit_file",
  "bash",
];

export interface ToolDiscoveryExposure {
  /** undefined = 不限制(full mode);否则首步/显式 active 名单。 */
  readonly activeTools: readonly string[] | undefined;
  /** true = 超限进入 discovery mode,activated 会并入后续 activeTools。 */
  readonly discovery: boolean;
}

/**
 * per-agent 的发现状态。Agent 实例是 per-run 装配的,但 invoke/stream 仍可被同一实例
 * 调多次(测试/将来复用)——所以每个 run 开始都 reset,状态绝不跨 run 泄漏。
 */
export class ToolDiscoveryController {
  private catalog: ReadonlyMap<string, AgentTool> = new Map();
  private activated = new Set<string>();
  private baseActiveTools: readonly string[] | undefined;
  private discovery = false;

  reset(catalog: ReadonlyMap<string, AgentTool>): void {
    this.catalog = catalog;
    this.activated.clear();
    this.baseActiveTools = undefined;
    this.discovery = false;
  }

  setExposure(exposure: ToolDiscoveryExposure): void {
    this.baseActiveTools =
      exposure.activeTools === undefined ? undefined : [...exposure.activeTools];
    this.discovery = exposure.discovery;
  }

  /** discovery mode 的首步 active:core ∩ catalog。 */
  initialActiveTools(): string[] {
    return CORE_TOOL_NAMES.filter((name) => this.catalog.has(name));
  }

  searchCatalog(): ReadonlyMap<string, AgentTool> {
    return this.catalog;
  }

  isDiscoveryMode(): boolean {
    return this.discovery;
  }

  activateTools(names: readonly string[]): {
    added: string[];
    alreadyActive: string[];
    omitted: string[];
  } {
    const added: string[] = [];
    const alreadyActive: string[] = [];
    const omitted: string[] = [];

    if (!this.discovery) {
      for (const name of names) {
        if (this.catalog.has(name)) alreadyActive.push(name);
      }
      return { added, alreadyActive, omitted };
    }

    const base = new Set(this.baseActiveTools ?? []);
    for (const name of names) {
      if (!this.catalog.has(name)) continue;
      if (base.has(name) || this.activated.has(name)) {
        alreadyActive.push(name);
        continue;
      }
      if (this.activated.size >= MAX_DISCOVERY_ACTIVATED_TOOLS) {
        omitted.push(name);
        continue;
      }
      this.activated.add(name);
      added.push(name);
    }

    return { added, alreadyActive, omitted };
  }

  /** 当前 step 应发给 provider 的 activeTools;full mode 返回 undefined(不限制)。 */
  activeTools(): readonly string[] | undefined {
    if (this.baseActiveTools === undefined) return undefined;
    if (!this.discovery) return this.baseActiveTools;
    return [...new Set([...this.baseActiveTools, ...this.activated])];
  }
}
