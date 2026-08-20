import {
  generateText,
  NoSuchToolError,
  type LanguageModel,
  type ToolCallRepairFunction,
  type ToolSet
} from "ai";

import type { AgentTelemetryEvent } from "./observer.js";

/**
 * 工具名修复(纯函数,不调模型)。
 *
 * 模型把 `read_file` 写成 `readFile` 是真实高频错误 —— 这类差异用字符串
 * 算法修得又快又准;调模型修名字既慢又会引入新幻觉(修出一个它以为存在
 * 其实不存在的名字)。
 *
 * 只在唯一命中时修:歧义时返回 undefined,让错误原样还给模型 ——
 * 修错名字比不修更糟(悄悄执行了另一个工具)。
 */
export const repairToolName = (
  candidate: string,
  availableNames: readonly string[]
): string | undefined => {
  const normalize = (s: string): string => s.toLowerCase().replaceAll("_", "");
  const target = normalize(candidate);

  const exact = availableNames.filter((name) => normalize(name) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;

  // 只在"唯一接近者"时修。注意不能只比"最近距离是否唯一":短候选是长名字
  // 的前缀时编辑距离天然偏小(read_f → read_foo=2,read_file=3),那会总是
  // 命中短的那个 —— 而模型写错时长的那个同样可能是本意。所以"只比一个近"
  // 的判定要落在绝对阈值上,而不是相对优胜上。
  const near = availableNames.filter(
    (name) => editDistance(normalize(name), target) <= 2
  );
  return near.length === 1 ? near[0] : undefined;
};

/** 经典 Levenshtein。名字都短(< 40 字符),O(n·m) 无感。 */
const editDistance = (a: string, b: string): number => {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = prev[j]!;
      prev[j] = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return prev[b.length]!;
};

/** 容忍 ```json fence 的 JSON 对象解析;剥完还不行才认输出无效。 */
const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  try {
    const parsed: unknown = JSON.parse(stripped);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const buildRepairPrompt = (input: {
  readonly toolName: string;
  readonly input: string;
  readonly schema: unknown;
  readonly errorMessage: string;
}): string =>
  [
    "You are fixing a tool call whose arguments failed schema validation.",
    `Tool: ${input.toolName}`,
    `Schema: ${JSON.stringify(input.schema)}`,
    `Invalid arguments: ${input.input}`,
    `Validation error: ${input.errorMessage}`,
    "Respond with ONLY the corrected arguments as a JSON object. No markdown fence, no explanation."
  ].join("\n");

export interface CreateRepairToolCallOptions {
  /** 修复用模型 —— tool 槽位(结构化杂务的既有槽位,R2 T7)。 */
  readonly repairModel: LanguageModel;
  /** 修复成功的观测出口(LeadAgent 把 observer 的 emit 闭包传进来)。 */
  readonly emit?: (event: AgentTelemetryEvent) => void;
}

/**
 * tool call 修复器(docs 04 §8.4 的 yg 同款)。
 *
 * 为什么用 generateText 而不是把错误塞回主 loop:主 loop 的重试是一整圈
 * (全部上下文 + 全部工具定义重发),修复只需要 "schema + 错误 + 原入参"
 * 三样东西,一次小生成解决。
 *
 * 只修一次:SDK 对同一个 tool call 只调一次本函数,返回 null 才把错误
 * 还给模型 —— 不在这里自建重试循环。修不好就让它报错,主 loop 下一轮
 * 看到的是一条明确的工具错误,比反复修复便宜且可观测。
 */
export const createRepairToolCall = (
  options: CreateRepairToolCallOptions
): ToolCallRepairFunction<ToolSet> => {
  const emit = (event: AgentTelemetryEvent): void => {
    try {
      options.emit?.(event);
    } catch {
      // 与 LeadAgent.emit 同一惯例:observer 错误永不许打断 loop。
    }
  };

  return async ({ toolCall, tools, inputSchema, error }) => {
    if (NoSuchToolError.isInstance(error)) {
      const repairedName = repairToolName(toolCall.toolName, Object.keys(tools));
      if (repairedName === undefined) return null;
      emit({ type: "tool_call_repaired", toolName: repairedName, kind: "name" });
      return { ...toolCall, toolName: repairedName };
    }

    const schema = await inputSchema({ toolName: toolCall.toolName });
    const repaired = await generateText({
      model: options.repairModel,
      prompt: buildRepairPrompt({
        toolName: toolCall.toolName,
        input: toolCall.input,
        schema,
        errorMessage: error.message
      })
    });

    const parsed = parseJsonObject(repaired.text);
    if (parsed === undefined) return null;

    emit({ type: "tool_call_repaired", toolName: toolCall.toolName, kind: "input" });
    return { ...toolCall, input: JSON.stringify(parsed) };
  };
};
