import { jsonSchema, tool as aiTool, type Tool, type ToolSet } from "ai";
import { z } from "zod";

import { toToolResultOutput } from "../query/tool-output.js";
import type { ToolDefinition, ToolExtra, ToolResult } from "../query/types.js";

// 契约里的工具类型在这里转出,tools 域的消费者不必直接 import query/types。
export type {
  JsonSchemaInput,
  ToolAnnotations,
  ToolDefinition,
  ToolExtra,
  ToolResult,
} from "../query/types.js";

/**
 * 工具构造与 `ToolResult` 的家 —— 全仓唯一的构造入口。
 *
 * 工具成败的判据是 `ToolResult.isError`，不再是输出字符串的 `"Error:"` 前缀 ——
 * 前缀只活在 `errorResult` 拼出的文本里，判定与文案不再各自抄字面量。
 */

/** pipeline 内流转的工具形状 —— 与契约 ToolDefinition 同一个东西(命名给读代码的人)。 */
export type PipelineTool<Input = Record<string, unknown>> = ToolDefinition<Input>;

/** 取消/超时统一收口文案（dsh 同款，文案保持不变）。 */
export const TOOL_CALL_ABORTED_OUTPUT = "Error: tool call aborted";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

/** 失败结果的模型可见文本 —— `Error: ${message}`,前缀由这里统一拼。 */
export const errorResult = (message: string): ToolResult => ({
  content: [{ type: "text", text: `Error: ${message}` }],
  isError: true,
});

/** 失败结果：从异常构造（`tool()` 的兜底用它，工具 execute 自己不抛）。 */
export const errorResultFrom = (error: unknown): ToolResult =>
  errorResult(errorText(error));

/** 正常结果：一个 text 块。 */
export const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

/** abort 时的收口结果。 */
export const aborted = (): ToolResult => ({
  content: [{ type: "text", text: TOOL_CALL_ABORTED_OUTPUT }],
  isError: true,
});

/** 把 `ToolResult.content` 拼成模型看到的字符串。 */
export const textOf = (result: ToolResult): string =>
  result.content.map((part) => part.text).join("");

/** inputSchema 的判别：JsonSchemaInput 还是 zod（契约的 union 形状）。 */
const isJsonSchemaInput = <Input>(
  schema: ToolDefinition<Input>["inputSchema"],
): schema is ToolDefinition<Input>["inputSchema"] & { readonly type: "json-schema" } =>
  typeof schema === "object" &&
  schema !== null &&
  "type" in schema &&
  (schema as { type?: unknown }).type === "json-schema";

/** execute 抛错 / abort 时的兜底：工具契约是「不抛」，这里是保险丝。 */
const guardExecute = async (
  execute: (input: never, extra: ToolExtra) => Promise<ToolResult>,
  input: unknown,
  extra: ToolExtra,
): Promise<ToolResult> => {
  try {
    return await execute(input as never, extra);
  } catch (error) {
    if (extra.signal.aborted) return aborted();
    return errorResultFrom(error);
  }
};

/**
 * zod 工具构造器。`execute` 收到的 input 已经过 `schema.parse`（应用 `.default()`）；
 * execute 抛错被兜成 `errorResult`，入参 signal 已 abort 时直接 `aborted()`。
 */
export const tool = <Input = Record<string, unknown>>(
  definition: PipelineTool<Input>,
): PipelineTool<Input> => {
  if (isJsonSchemaInput(definition.inputSchema)) {
    // json-schema 分支不该出现在 tool()：MCP 走 toolFromJsonSchema。
    throw new TypeError("tool() 只接 zod inputSchema；JSON Schema 用 toolFromJsonSchema");
  }
  const schema = definition.inputSchema as z.ZodType<Input>;
  const guarded: ToolDefinition<Input>["execute"] = async (input, extra) => {
    try {
      const parsed = schema.parse(input);
      if (extra.signal.aborted) return aborted();
      return await guardExecute(definition.execute, parsed, extra);
    } catch (error) {
      if (extra.signal.aborted) return aborted();
      return errorResultFrom(error);
    }
  };
  return { ...definition, execute: guarded };
};

/**
 * JSON Schema（MCP）工具构造器。inputSchema 原样交给 AI SDK，不做 zod 转换 ——
 * 外部工具（MCP server）只能拿到 JSON Schema，硬转 zod 既有损又没必要。
 * execute 同样有 guard（MCP 调用抛错 → `Error:` 文本）。
 */
export const toolFromJsonSchema = <Input = Record<string, unknown>>(
  definition: PipelineTool<Input>,
): PipelineTool<Input> => {
  if (!isJsonSchemaInput(definition.inputSchema)) {
    throw new TypeError("toolFromJsonSchema 只接 JsonSchemaInput；zod 用 tool()");
  }
  const guarded: ToolDefinition<Input>["execute"] = (input, extra) =>
    guardExecute(definition.execute, input, extra);
  return { ...definition, execute: guarded };
};

/**
 * AI SDK 适配：模型看到的是 `textOf(result)`；`isError` 映射成 error-text
 * （provider 译成 tool_result 的 is_error: true —— Claude Code 同款）。
 */
const toModelOutput = (): NonNullable<Tool["toModelOutput"]> =>
  ({ output }) => {
    const result = output as ToolResult;
    return toToolResultOutput(textOf(result), result.isError === true);
  };

/**
 * `ToolDefinition` → AI SDK `Tool`。传给 `streamText` 的每个工具都经过这里：
 * `toModelOutput` 保证模型看到的文本与旧字符串返回值逐字一致，成败走 output.type。
 */
export const toAiTool = (definition: ToolDefinition): Tool => {
  const schema = isJsonSchemaInput(definition.inputSchema)
    ? jsonSchema(
      (definition.inputSchema as { schema: Record<string, unknown> })
        .schema as Parameters<typeof jsonSchema>[0],
    )
    : (definition.inputSchema as z.ZodType<unknown>);
  return aiTool({
    description: definition.description,
    // AI SDK 的 Tool 泛型边界：input/output 通道是 unknown（唯一允许的 as 边界）。
    inputSchema: schema as Parameters<typeof aiTool>[0]["inputSchema"],
    execute: async (rawInput: unknown, options) => {
      const extra: ToolExtra = {
        toolUseID:
          (options as { toolCallId?: string } | undefined)?.toolCallId ??
          `auto-${crypto.randomUUID()}`,
        signal:
          (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal ??
          new AbortController().signal,
      };
      return definition.execute(rawInput as never, extra);
    },
    toModelOutput: toModelOutput(),
  }) as Tool;
};

/**
 * `PipelineTool` 数组 → streamText 需要的 ToolSet。
 * key 用工具的 name；必须在包装链装配完成之后调用（execute 闭包携带整条链）。
 */
export const toToolSet = (tools: readonly PipelineTool[]): ToolSet => {
  const set: ToolSet = {};
  for (const pipelineTool of tools) {
    set[pipelineTool.name] = toAiTool(pipelineTool);
  }
  return set;
};
