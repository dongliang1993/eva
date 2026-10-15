import { ToolDiscoveryController } from "./tool-discovery.js";
import { DEFAULT_READ_ONLY_CONCURRENCY, Semaphore } from "./concurrency-cap.js";
import { createToolSearchTool } from "./tool-search/index.js";
import type { PipelineTool } from "./tool.js";
import { toAiTool } from "./tool.js";
import type { Tool } from "ai";
import { runToolCall } from "../query/tool-call.js";
import type { ToolCallContext, ToolTimingMutable } from "../query/tool-call.js";
import type {
  CanUseTool,
  HookEvent,
  HookCallbackMatcher,
} from "../query/types.js";

export interface ToolPipelineOptions {
  readonly tools?: readonly PipelineTool[];
  /** 唯一权限入口;undefined = 走到 canUseTool 的调用全 deny。 */
  readonly canUseTool?: CanUseTool;
  readonly hooks?: Partial<Record<HookEvent, readonly HookCallbackMatcher[]>>;
  readonly readOnlyConcurrency?: number;
  /** 子代理调用带它(= taskId);主 agent 不带。 */
  readonly agentID?: string;
}

export interface ToolPipeline {
  readonly drain: () => Promise<void>;
  /** run-loop 直接消费的 AI SDK ToolSet(execute = runToolCall)。 */
  readonly toolSet: Record<string, Tool>;
  /** 原始工具目录(含 tool_search)—— discovery/快照的输入。 */
  readonly catalog: ReadonlyMap<string, PipelineTool>;
  readonly toolDiscovery: ToolDiscoveryController;
  /** 三段计时;mapper 在 tool-result 时取快照。 */
  readonly timings: Map<string, ToolTimingMutable>;
  /** deny.interrupt 置位过 → 本轮在全部工具收口后结束。 */
  tookInterruptSignal(): boolean;
}

/**
 * Agent 工具横切能力的唯一装配点。
 *
 * 一次工具调用的生命周期在 runToolCall 里(hooks → 权限 → 并发位 → execute → hooks);
 * 这里只做装配:重名检查、tool_search 注入、drain 台账、把 runToolCall 包进 toAiTool。
 */
export const buildToolPipeline = (options: ToolPipelineOptions): ToolPipeline => {
  const names = new Set<string>(["tool_search"]);
  for (const t of options.tools ?? []) {
    if (names.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    names.add(t.name);
  }
  const toolDiscovery = new ToolDiscoveryController();
  const tools = [
    ...(options.tools ?? []),
    createToolSearchTool(toolDiscovery),
  ];

  const timings = new Map<string, ToolTimingMutable>();
  let interruptSignalled = false;
  const agentID = options.agentID;
  const ctx: ToolCallContext = {
    canUseTool: options.canUseTool,
    hooks: options.hooks ?? {},
    readOnlyLimiter: new Semaphore(
      options.readOnlyConcurrency ?? DEFAULT_READ_ONLY_CONCURRENCY,
    ),
    timings,
    ...(agentID !== undefined ? { agentID } : {}),
  };

  // 在飞台账:drain 在 run 结束前等已派发的工具收口(取消不 detach 执行)。
  const pending = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };

  const toolSet: Record<string, Tool> = {};
  for (const t of tools) {
    const definition = t;
    // execute 入口 = runToolCall;AI SDK 的 toolCallId/abortSignal 经 toAiTool 进 extra。
    const wrapped: PipelineTool = {
      ...definition,
      execute: (input, extra) => {
        const task = Promise.resolve().then(() =>
          runToolCall(definition, input as Record<string, unknown>, extra, ctx),
        ).then(({ result, interruptTurn }) => {
          if (interruptTurn) interruptSignalled = true;
          return result;
        });
        return track(task);
      },
    };
    toolSet[t.name] = toAiTool(wrapped);
  }

  return {
    toolSet,
    catalog: new Map(tools.map((t) => [t.name, t])),
    toolDiscovery,
    timings,
    tookInterruptSignal: () => interruptSignalled,
    drain: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
};
