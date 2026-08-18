import { z } from "zod";

import type { AgentTool } from "@eva/harness";

/** 单条用户输入的长度上限 —— 超过这个量应该走文件附件,不是聊天框。 */
const MAX_TEXT_LENGTH = 100_000;

/**
 * 一次执行的请求体。
 *
 * 旧契约收一个完整 messages 数组(还兼容 5 个 LangChain 遗留 role),
 * 但服务端会用自己的历史整个覆盖掉,只取最后一条的 content —— 实际语义
 * 就是"一句话 + 会话 id"。这里让 schema 说实话。
 */
export const runRequestSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  /** 缺省 = 新建会话,响应的 run_start 帧会带回新 sessionId。 */
  sessionId: z.string().optional(),
  /** "providerId:modelId";缺省用 settings 里的默认模型。 */
  modelId: z.string().optional()
});

export type RunRequest = z.infer<typeof runRequestSchema>;

export interface RunInput {
  text: string;
  sessionId?: string;
  modelId?: string;
  context?: Record<string, unknown>;
  additionalTools?: AgentTool[];
  abortSignal?: AbortSignal;
}