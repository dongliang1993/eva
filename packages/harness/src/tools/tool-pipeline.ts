import type { AgentObserver } from "../agents/observer.js";
import { ToolDiscoveryController } from "../agents/tool-discovery.js";
import type { RequestApproval, AgentRunInput } from "../agents/types.js";
import { DEFAULT_READ_ONLY_CONCURRENCY, Semaphore, withConcurrencyCap } from "./concurrency-cap.js";
import type { PipelineTool } from "./tool.js";
import { toToolSet } from "./tool.js";
import { withPlanGate, type PlanGateState } from "./plan-gate/index.js";
import { createToolSearchTool } from "./tool-search/index.js";
import { createToolTimingState, type ToolTimingState } from "./tool-timing.js";
import { withApproval } from "./with-approval.js";
import { withExecTiming } from "./with-exec-timing.js";

export interface ToolPipelineOptions {
  readonly onToolExecution?: AgentRunInput["onToolExecution"];
  readonly tools?: readonly PipelineTool[];
  readonly requestApproval?: RequestApproval;
  readonly observer?: AgentObserver;
  readonly readOnlyConcurrency?: number;
  readonly planGateState?: PlanGateState;
}

export interface ToolPipeline {
  readonly drain: () => Promise<void>;
  readonly tools: PipelineTool[];
  readonly toolDiscovery: ToolDiscoveryController;
  readonly toolTiming: ToolTimingState;
}

/**
 * Agent 工具横切能力的唯一装配点。
 *
 * 执行顺序固定为 plan gate → approval → concurrency cap → execution timing → tool。
 * 这个顺序属于运行语义：被 plan gate 拦截的写操作不能先弹审批框,人工审批等待也
 * 不能占用只读并发额度,审批与排队耗时也不能混入真实执行时长。
 */
export const buildToolPipeline = (options: ToolPipelineOptions): ToolPipeline => {
  const requestApproval = options.requestApproval ?? (async () => false);
  const names = new Set<string>(["tool_search"]);
  for (const tool of options.tools ?? []) {
    if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }
  const planGateState = options.planGateState;
  const limiter = new Semaphore(
    options.readOnlyConcurrency ?? DEFAULT_READ_ONLY_CONCURRENCY,
  );
  const toolDiscovery = new ToolDiscoveryController();
  const toolTiming = createToolTimingState();
  const withDiscoveryTools = [
    ...(options.tools ?? []),
    createToolSearchTool(toolDiscovery),
  ];
  const timedTools = withDiscoveryTools.map((tool) =>
    withExecTiming(tool, toolTiming, options.onToolExecution),
  );
  const cappedTools = timedTools.map((tool) =>
    withConcurrencyCap(tool, limiter, toolTiming),
  );
  const approvalTools = cappedTools.map((tool) =>
    withApproval(tool, requestApproval, options.observer, toolTiming),
  );
  const tools = planGateState
    ? approvalTools.map((tool) => withPlanGate(tool, planGateState))
    : approvalTools;

  // 在飞台账:drain 在 run 结束前等已派发的工具收口(取消不 detach 执行)。
  const pending = new Set<Promise<unknown>>();
  const trackedTools = tools.map((pipelineTool) => {
    const execute = pipelineTool.execute;
    const tracked: PipelineTool["execute"] = (input, extra) => {
      const task = Promise.resolve().then(() => execute(input, extra));
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    };
    return { ...pipelineTool, execute: tracked };
  });
  return {
    tools: trackedTools, toolDiscovery, toolTiming,
    drain: async () => { while (pending.size) await Promise.allSettled([...pending]); }
  };
};

/** 兼容 re-export:run-loop 由此处取 ToolSet。 */
export { toToolSet };
