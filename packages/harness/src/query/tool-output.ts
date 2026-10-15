import type { ToolResultPart } from "ai";

import type { ToolResult } from "./types.js";

/**
 * 工具成败的唯一事实源:ToolResult.isError ↔ AI SDK 的 error-text。
 *
 * 照 Claude Code:失败落在 tool_result 块的 is_error 上,所有消费者读这个位,
 * 不嗅文本前缀。AI SDK 的对应物是 ToolResultOutput 的 error-text / error-json
 * (Anthropic provider 把它译成 is_error: true;DB 回灌时 output-error 也还原成 error-text)。
 * 文案(含 "Error: " 前缀)原样保留 —— 那是给模型看的,不再承担判定。
 */

export type ToolResultOutput = ToolResultPart["output"];

/** ToolResult → 回灌给模型的 output(toModelOutput 与补发结果共用)。 */
export const toToolResultOutput = (text: string, isError: boolean): ToolResultOutput =>
  isError ? { type: "error-text", value: text } : { type: "text", value: text };

/** output 是否表示失败。只看结构。 */
export const isErrorOutput = (output: ToolResultOutput): boolean =>
  output.type === "error-text" ||
  output.type === "error-json" ||
  output.type === "execution-denied";

/** output 拍平成文本(帧、轨迹、compact 摘要共用)。 */
export const toolOutputText = (output: ToolResultOutput): string => {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return typeof output.value === "string" ? output.value : JSON.stringify(output.value);
    case "execution-denied":
      return `Execution denied${output.reason ? `: ${output.reason}` : ""}`;
    default:
      return JSON.stringify(output);
  }
};

const isToolResult = (value: unknown): value is ToolResult =>
  typeof value === "object" && value !== null &&
  Array.isArray((value as { content?: unknown }).content);

const isToolResultOutput = (value: unknown): value is ToolResultOutput =>
  typeof value === "object" && value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/**
 * stream 上 tool-result part 的 output → (文本, 成败)。
 * part.output 是 execute 的原样返回(ToolResult);补发/历史路径已是 ToolResultOutput。
 */
export const readToolOutput = (
  output: unknown,
): { readonly text: string; readonly isError: boolean } => {
  if (isToolResult(output)) {
    return {
      text: output.content.map((part) => part.text).join(""),
      isError: output.isError === true,
    };
  }
  if (isToolResultOutput(output)) {
    return { text: toolOutputText(output), isError: isErrorOutput(output) };
  }
  return { text: JSON.stringify(output ?? null), isError: false };
};
