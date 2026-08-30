import { buildToolPipeline } from "../tools/tool-pipeline.js";
import { createRunLoopAgent } from "./run-loop.js";
import type { Agent, CreateAgentOptions } from "./types.js";

/**
 * Harness 的 Agent 组合根。这里只决定依赖如何装配；循环、恢复与收尾策略分别由
 * run-loop、recovery-policy、finish-run 承担。
 */
export const createAgent = (options: CreateAgentOptions): Agent => {
  const {
    tools,
    requestApproval,
    readOnlyConcurrency,
    observer,
    planGateState,
    ...runLoopOptions
  } = options;
  const pipeline = buildToolPipeline({
    ...(tools !== undefined ? { tools } : {}),
    ...(requestApproval !== undefined ? { requestApproval } : {}),
    ...(readOnlyConcurrency !== undefined ? { readOnlyConcurrency } : {}),
    ...(observer !== undefined ? { observer } : {}),
    ...(planGateState !== undefined ? { planGateState } : {}),
  });

  return createRunLoopAgent({
    ...runLoopOptions,
    tools: pipeline.tools,
    toolDiscovery: pipeline.toolDiscovery,
    toolTiming: pipeline.toolTiming,
    ...(observer !== undefined ? { observer } : {}),
    ...(planGateState !== undefined ? { planGateState } : {}),
  });
};
