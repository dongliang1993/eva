import { z } from "zod";

/** 单条用户输入的长度上限 —— 超过这个量应该走文件附件,不是聊天框。 */
const MAX_TEXT_LENGTH = 100_000;

/**
 * 一次执行的请求体。text 与 retryMessageId 二选一。
 *
 * 旧契约收完整 messages 数组,但服务端用自己的历史覆盖,实际语义就是
 * "一句话(+ 会话 id)"。这里让 schema 说实话,并扩展 retry 模式。
 */
export const runRequestSchema = z
  .object({
    /** 新消息。与 retryMessageId 二选一。 */
    text: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
    /** 缺省 = 新建会话,响应的 run_start 帧会带回新 sessionId。 */
    sessionId: z.string().optional(),
    /** "providerId:modelId";缺省用 settings 里的默认模型。 */
    modelId: z.string().optional(),
    /**
     * 重新生成这条 assistant 消息(同槽位落一个新版本)。
     * 必须同时给 sessionId;且 retryMessageId 必须 = 该会话 activeLeafId。
     */
    retryMessageId: z.string().optional()
  })
  .superRefine((val, ctx) => {
    const hasText = val.text !== undefined && val.text.length > 0;
    const hasRetry = val.retryMessageId !== undefined;

    if (hasText === hasRetry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasText ? "retryMessageId" : "text"],
        message: hasText
          ? "retry 模式不能同时给 text"
          : "text 与 retryMessageId 必须二选一"
      });
    }

    if (hasRetry && val.sessionId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sessionId"],
        message: "retry 模式必须同时给 sessionId"
      });
    }
  });

export type RunRequest = z.infer<typeof runRequestSchema>;