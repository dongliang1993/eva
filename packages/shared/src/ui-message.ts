import type { UIMessage } from "ai";

import type { StreamTokenUsage } from "./stream-events.js";

/**
 * 消息级 metadata —— 与 UIMessage 一起整存在 `messages.message` 列里。
 * 不再有独立的 metadata / token_usage 列:一条消息只有一个事实源。
 */
export interface EvaMessageMetadata {
  /** 产生这条消息的 run(user 消息也带,便于按 run 回溯整轮)。 */
  readonly runId?: string;
  /** "providerId:modelId"。仅 assistant 消息有。 */
  readonly model?: string;
  /** 首个 text-delta 之前的等待时长(UI 的 "Thought for Xs")。 */
  readonly thinkingDurationMs?: number;
  /** 从 run 开始到消息完成的墙钟耗时。 */
  readonly durationMs?: number;
  readonly usage?: StreamTokenUsage;
  /** 该消息因 abort 提前结束 —— parts 可能不完整。 */
  readonly aborted?: boolean;
  /**
   * S7:这条 user 消息其实是 runtime 注入的子代理通知,不是用户说的话。
   * DB 的 role 枚举只有 user/assistant,所以通知只能以 user 落库 —— UI 必须靠
   * 这个标记把它渲染成通知条,否则会显示成右对齐的用户气泡(像用户自己说的)。
   */
  readonly noticeKind?: "subagent_reported" | "subagent_settled";
  /** 通知对应的子代理任务名(渲染通知条时显示)。 */
  readonly noticeDescription?: string;
}

/**
 * Eva 的消息表示 = AI SDK UIMessage。
 *
 * 为什么不自造中间表示:自造的 MessageContentBlock 需要在"落库/还原历史/渲染"
 * 三处各写一份解析,且工具轨迹无法无损还原成模型可见的 tool role 消息。
 * UIMessage 能被 convertToModelMessages 直接消费,读写零转换。
 */
export type EvaUIMessage = UIMessage<EvaMessageMetadata>;

export type EvaUIMessagePart = EvaUIMessage["parts"][number];

export type EvaTextPart = Extract<EvaUIMessagePart, { type: "text" }>;
export type EvaDynamicToolPart = Extract<EvaUIMessagePart, { type: "dynamic-tool" }>;

export const isTextPart = (part: EvaUIMessagePart): part is EvaTextPart =>
  part.type === "text";

/**
 * harness 的工具全部是运行时注册的,AI SDK 侧对应 `dynamic-tool` part
 * (而不是静态工具的 `tool-<NAME>`)。
 */
export const isDynamicToolPart = (
  part: EvaUIMessagePart
): part is EvaDynamicToolPart => part.type === "dynamic-tool";

/** SDK 原生 reasoning part(对接 reasoning-delta,渲染成 Think 块)。 */
export const isReasoningPart = (
  part: EvaUIMessagePart
): part is Extract<EvaUIMessagePart, { type: "reasoning" }> => part.type === "reasoning";

/**
 * 剥离一条消息里全部 reasoning part。
 *
 * 为什么:reasoning 是给用户看的"思考轨迹",不是给模型回灌的上下文 ——
 * 无 signature 的纯文本 reasoning 在部分 provider 的回灌请求里会被拒绝
 * (buildModelHistory 后用 convertToModelMessages 重新组装时,SDK 会把
 * reasoning part 映射回 { type: "reasoning", text })。所以每次把历史喂回
 * 模型前,都先剥掉 reasoning。渲染/落库则保留(Think 块需要它)。
 */
export const stripReasoningParts = (message: EvaUIMessage): EvaUIMessage => {
  const hasReasoning = message.parts.some(isReasoningPart);
  if (!hasReasoning) {
    return message;
  }

  return {
    ...message,
    parts: message.parts.filter((part) => !isReasoningPart(part))
  };
};

export const createUserUIMessage = (
  id: string,
  text: string,
  metadata?: EvaMessageMetadata
): EvaUIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text, state: "done" }],
  ...(metadata !== undefined ? { metadata } : {})
});

/** parts 里的正文拼接(会话标题、token 估算、记忆检索用)。 */
export const uiMessageText = (message: EvaUIMessage): string =>
  message.parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n")
    .trim();

/** dynamic-tool part 的输出(无输出时返回空串)。 */
export const toolPartOutput = (part: EvaDynamicToolPart): string => {
  if (part.state === "output-available") {
    return typeof part.output === "string"
      ? part.output
      : JSON.stringify(part.output);
  }

  if (part.state === "output-error") {
    return part.errorText;
  }

  return "";
};

/**
 * 工具输出进 FTS 索引的长度上限。
 * 沿用旧 extractSearchText 的 1000 字符 —— 超过这个长度的多半是文件全文/网页
 * 正文,进索引只会稀释 rank。
 */
const TOOL_OUTPUT_SEARCH_LIMIT = 1000;

/** `messages.search_text` 列的值(FTS5 索引源)。 */
export const uiMessageSearchText = (message: EvaUIMessage): string => {
  const chunks: string[] = [];

  for (const part of message.parts) {
    if (isTextPart(part)) {
      chunks.push(part.text);
      continue;
    }

    if (isDynamicToolPart(part) && part.state === "output-available") {
      const output = toolPartOutput(part);

      if (output.length <= TOOL_OUTPUT_SEARCH_LIMIT) {
        chunks.push(output);
      }
    }
  }

  return chunks.join(" ").trim();
};

/**
 * 解析 `messages.message` 列。
 * 解析失败/形状不对时降级成单 text part —— 历史脏数据不该让整条会话打不开。
 */
export const parseUIMessage = (
  raw: string,
  fallback: { id: string; role: "user" | "assistant" }
): EvaUIMessage => {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed === "object"
      && parsed !== null
      && Array.isArray((parsed as { parts?: unknown }).parts)
    ) {
      return parsed as EvaUIMessage;
    }
  } catch {
    // 落到下面的降级分支
  }

  return {
    id: fallback.id,
    role: fallback.role,
    parts: [{ type: "text", text: raw, state: "done" }]
  };
};