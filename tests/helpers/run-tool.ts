import type { PipelineTool } from "../../packages/harness/src/tools/tool.js";
import type { ToolExtra, ToolResult } from "../../packages/harness/src/query/types.js";
import { textOf } from "../../packages/harness/src/tools/tool.js";

/**
 * 测试助手:像 toAiTool 一样调一个 PipelineTool 的 execute。
 * 返回完整 ToolResult —— 行为断言用 textOf(result) 读文本、result.isError 读状态。
 */
export const runTool = (
  tool: PipelineTool,
  input: unknown,
  extra: Partial<ToolExtra> = {},
): Promise<ToolResult> =>
  tool.execute(input as never, {
    toolUseID: extra.toolUseID ?? `test-${crypto.randomUUID()}`,
    signal: extra.signal ?? new AbortController().signal,
  });

/** runTool + 直接取模型可见文本。 */
export const runToolText = async (
  tool: PipelineTool,
  input: unknown,
  extra: Partial<ToolExtra> = {},
): Promise<string> => textOf(await runTool(tool, input, extra));
