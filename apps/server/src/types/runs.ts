import { z } from "zod";

/** 单条用户输入的长度上限 —— 超过这个量应该走文件附件,不是聊天框。 */
const MAX_TEXT_LENGTH = 100_000;

/**
 * 一次执行的请求体。text 与 retryMessageId 二选一。
 *
 * 旧契约收完整 messages 数组,但服务端用自己的历史覆盖,实际语义就是
 * "一句话(+ 会话 id)"。这里让 schema 说实话,并扩展 retry 模式。
 *
 * modelId 是 per-run 选定的模型 —— 不再有全局默认。新消息(text)必须带它;
 * retry 模式可不带,服务端用会话记录的 model(就是上次 run 选的那个)兜底。
 */
export const runRequestSchema = z
  .object({
    /** 新消息。与 retryMessageId 二选一。 */
    text: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
    /** 缺省 = 新建会话,响应的 run_start 帧会带回新 sessionId。 */
    sessionId: z.string().optional(),
    /** "providerId:modelId"。新消息必填;retry 缺省时用会话记录的 model。 */
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

    // 新消息必须有 modelId —— 模型是 per-run 选的,没有全局默认兜底。
    // retry 不要求:服务端用会话记录的 model(上次 run 选的那个)。
    if (hasText && (val.modelId === undefined || val.modelId.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelId"],
        message: "新消息必须指定 modelId(providerId:modelId)"
      });
    }
  });

export type RunRequest = z.infer<typeof runRequestSchema>;