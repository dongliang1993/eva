/**
 * T39/T43/T44:工具数安全网(Alma PM-011)。
 *
 * T39 是「裁 Map」:>40 只留 fs/bash 最小集,MCP 工具整体消失。T43 升级为
 * 「保留 toolSet + activeTools 分步暴露」:超限时不删工具,首步只 active
 * core tools + tool_search,模型搜索激活后下一 step 可用。T44 再加
 * preferredToolNames(skill allowed-tools):>40 时并入首步 active(core ∪ preferred,
 * 仍受 40 上限);<=40 时全集本来就可用,不改变行为。显式 activeToolNames 永远优先。
 */
import type { PipelineTool } from "./index.js";
import {
  TOOL_COUNT_SAFETY_LIMIT,
  type ToolDiscoveryController,
} from "./tool-discovery.js";

export { TOOL_COUNT_SAFETY_LIMIT };

export interface ToolExposureResult {
  /** 传给 streamText/prepareStep 的 activeTools;undefined = 不限制。 */
  readonly activeTools: readonly string[] | undefined;
  /** true = 触发了超限 discovery mode(调用方应发 tool_count_degraded + warning)。 */
  readonly degraded: boolean;
  readonly totalCount: number;
  /** 首步/显式 active 的工具数(语义:T43 后不是「剩余全部工具数」)。 */
  readonly keptCount: number;
}

/**
 * 计算本轮工具暴露策略。
 *
 * 1. 数量 ≤ limit → 不限制(activeTools=undefined),degraded=false;
 * 2. 数量 > limit → discovery mode:首步 active = core ∩ catalog + tool_search。
 *    (显式 activeToolNames/preferredToolNames 已随 AgentRunInput 删。)
 */
export const resolveToolExposure = (
  tools: ReadonlyMap<string, PipelineTool>,
  discovery: ToolDiscoveryController,
): ToolExposureResult => {
  discovery.reset(tools);

  if (tools.size <= TOOL_COUNT_SAFETY_LIMIT) {
    discovery.setExposure({ activeTools: undefined, discovery: false });
    return {
      activeTools: undefined,
      degraded: false,
      totalCount: tools.size,
      keptCount: tools.size,
    };
  }

  const initialActiveTools = discovery.initialActiveTools();
  discovery.setExposure({ activeTools: initialActiveTools, discovery: true });
  return {
    activeTools: initialActiveTools,
    degraded: true,
    totalCount: tools.size,
    keptCount: initialActiveTools.length,
  };
};
