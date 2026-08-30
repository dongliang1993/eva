import type { AgentObserver } from "../agents/observer.js";
import { ToolDiscoveryController } from "../agents/tool-discovery.js";
import type { RequestApproval } from "../agents/types.js";
import { DEFAULT_READ_ONLY_CONCURRENCY, Semaphore, withConcurrencyCap } from "./concurrency-cap.js";
import type { AgentTool } from "./build-tool.js";
import { withPlanGate, type PlanGateState } from "./plan-gate/index.js";
import { createToolSearchTool } from "./tool-search/index.js";
import { createToolTimingState, type ToolTimingState } from "./tool-timing.js";
import { withApproval } from "./with-approval.js";
import { withExecTiming } from "./with-exec-timing.js";

export interface ToolPipelineOptions {
  readonly tools?: readonly AgentTool[];
  readonly requestApproval?: RequestApproval;
  readonly observer?: AgentObserver;
  readonly readOnlyConcurrency?: number;
  readonly planGateState?: PlanGateState;
}

export interface ToolPipeline {
  readonly tools: AgentTool[];
  readonly toolDiscovery: ToolDiscoveryController;
  readonly toolTiming: ToolTimingState;
}

/**
 * Agent 工具横切能力的唯一装配点。
 *
 * 执行顺序固定为 plan gate → approval → concurrency cap → execution timing → tool。
 * 这个顺序属于运行语义：被 plan gate 拦截的写操作不能先弹审批框，人工审批等待也
 * 不能占用只读并发额度，审批与排队耗时也不能混入真实执行时长。
 */
export const buildToolPipeline = (options: ToolPipelineOptions): ToolPipeline => {
  const requestApproval = options.requestApproval;
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
    withExecTiming(tool, toolTiming),
  );
  const cappedTools = timedTools.map((tool) =>
    withConcurrencyCap(tool, limiter, toolTiming),
  );
  const approvalTools = requestApproval
    ? cappedTools.map((tool) =>
        withApproval(
          tool,
          requestApproval,
          options.observer,
          toolTiming,
        ),
      )
    : cappedTools;
  const tools = planGateState
    ? approvalTools.map((tool) => withPlanGate(tool, planGateState))
    : approvalTools;

  return { tools, toolDiscovery, toolTiming };
};
