import { tool, type Tool, type ToolSet } from "ai";
import type { z } from "zod";

// ai 的 Tool 不带 name(name 是 ToolSet 的 key),但 eva 的 Agent 要按 name 查工具
// (toolCall.name → tool)。所以 AgentTool 包一层 name,内部持有 ai Tool。
export interface AgentTool {
  readonly name: string;
  readonly tool: Tool;
  readonly readOnly?: boolean;
  /** 危险工具标记(与 SDK needsApproval 同名对齐);由 createAgent 用 withApproval 包装 execute 实现闸门。 */
  readonly needsApproval?: boolean;
}

/** buildTool 的非 input 执行上下文 —— 只挑出工具真正关心的字段,不把整个 SDK options 泄出去。 */
export interface ToolExecutionOptions {
  /** SDK 派发的工具调用 id(卡片/历史 / fork 的 parent 挂点靠它归位)。 */
  readonly toolCallId: string;
  /**
   * 取消信号 = run 被取消 ∪ SDK 工具超时(streamText timeout 经 mergeAbortSignals
   * 折进来)。工具应尽早检查并以业务返回值(而非 throw)收尾 —— race 兜底
   * 已在包装层统一兜住"挂死不返回",工具自查的意义是把报错写得更具体。
   * 可选:直接调用 execute(测试/无 SDK 上下文)时无信号。
   */
  readonly abortSignal?: AbortSignal;
}

export interface ToolDefinition<S extends z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string | (() => string);
  /** 与 SDK tool() 的 inputSchema 同名对齐 —— 透传给 tool(),execute 前 schema.parse 应用 .default()。 */
  inputSchema: S;
  /**
   * 业务 execute。第二个可选参数携带 SDK 的调用元数据 —— 需要把自己那次调用的
   * toolCallId 落到侧边(fork 的 parent 挂点、审计)的工具才声明第二个参数;
   * 其余工具保持一个参数,不用改。
   */
  execute: (input: z.infer<S>, options?: ToolExecutionOptions) => Promise<string>;
  readOnly?: boolean;
  needsApproval?: boolean;
}

/**
 * 工具执行失败的输出前缀。
 * `stream-part-mapper.ts` 靠它把 tool-result 判成 error 状态；`buildTool` 与
 * `buildJsonSchemaTool` 靠它包装执行异常。三处共用这一个定义，不要各自抄字面量。
 * 文案对齐 dsh 的 "Error: tool call aborted" 形态:前缀即错误行本身。
 */
export const TOOL_ERROR_PREFIX = "Error:";

export const toToolErrorOutput = (error: unknown): string =>
  `${TOOL_ERROR_PREFIX} ${error instanceof Error ? error.message : "Unknown error"}`;

/** 取消/超时统一收口文案(dsh 同款)。 */
export const TOOL_CALL_ABORTED_OUTPUT = `${TOOL_ERROR_PREFIX} tool call aborted`;

/**
 * T25 race 兜底:signal 触发时立即以错误文本 settle,不等业务 execute。
 * race 是软取消 —— 原 promise 还在跑,只是结果被丢弃(fs 写已发出就会写完,
 * 但 run 不再被挂住)。文案不说"已回滚":写操作可能已部分完成。
 */
const abortFallback = (signal: AbortSignal): Promise<string> =>
  new Promise<string>((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(TOOL_CALL_ABORTED_OUTPUT);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const buildTool = <S extends z.ZodObject<z.ZodRawShape>>(
  definition: ToolDefinition<S>
): AgentTool => {
  const description =
    typeof definition.description === "function"
      ? definition.description()
      : definition.description;

  const built: Tool = tool({
    description,
    inputSchema: definition.inputSchema,
    execute: async (input, options) => {
      try {
        // parse 应用 schema 的 .default() 等默认值,再交给业务 execute。
        const parsed = definition.inputSchema.parse(input);
        // 只把 SDK 的调用 id 和取消信号挑出来传给工具;其余 options 不外泄。
        // 直接调用 execute(input)(测试/无 SDK 上下文)时 options 缺省 → 给临时 id,不炸。
        const toolCallId = options?.toolCallId ?? `auto-${crypto.randomUUID()}`;
        const signal = options?.abortSignal;
        if (signal?.aborted) {
          return TOOL_CALL_ABORTED_OUTPUT;
        }
        const toolOptions: ToolExecutionOptions = {
          toolCallId,
          ...(signal !== undefined ? { abortSignal: signal } : {})
        };
        return await (signal !== undefined
          ? Promise.race([definition.execute(parsed, toolOptions), abortFallback(signal)])
          : definition.execute(parsed, toolOptions));
      } catch (error) {
        return toToolErrorOutput(error);
      }
    }
  });

  return {
    name: definition.name,
    tool: built,
    ...(definition.readOnly !== undefined ? { readOnly: definition.readOnly } : {}),
    ...(definition.needsApproval !== undefined
      ? { needsApproval: definition.needsApproval }
      : {})
  };
};

/**
 * 把 AgentTool 数组转成 streamText 需要的 ToolSet (Record<string, Tool>)。
 * key 用工具的 name。streamText 内部按 key 派生 toolName。
 */
export const toToolSet = (tools: readonly AgentTool[]): ToolSet => {
  const set: ToolSet = {};
  for (const agentTool of tools) {
    set[agentTool.name] = agentTool.tool;
  }
  return set;
};
