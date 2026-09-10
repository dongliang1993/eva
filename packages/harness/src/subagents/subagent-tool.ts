import { z } from "zod";

import { buildTool, type AgentTool } from "../tools/index.js";

export type ForkRunner = (invocation: {
  readonly abortSignal?: AbortSignal;
  readonly prompt: string;
  readonly subagentType: string;
  readonly description: string;
  readonly taskId: string;
  readonly parentToolCallId: string;
}) => Promise<{ readonly text: string }>;

export interface SubagentToolContext {
  readonly runFork: ForkRunner;
}

const subagentSchema = z.object({
  description: z.string().min(1).describe(
    "A short (3-5 word) description of the delegated task, for display."
  ),
  prompt: z.string().min(1).describe(
    "The complete, self-contained task for the subagent. It does not share this " +
    "conversation's context, so include everything it needs."
  ),
  subagent: z.string().optional().describe(
    "Subagent type to fork. Defaults to explorer."
  ),

});

export const createSubagentTool = (ctx: SubagentToolContext): readonly AgentTool[] => {
  const subagent = buildTool({
    name: "subagent",
    description: [
      "Delegate a self-contained task to a subagent (a separate agent that works in its own " +
      "context) to offload focused, independent work — research, a scoped analysis — so it does " +
      "not consume this conversation's context.",
      "The subagent returns its result, not its intermediate steps. Give it a complete, " +
      "standalone prompt: it does not see this conversation.",
      "The tool waits for the child and returns its final result. Independent calls may run in parallel."
    ].join("\n"),
    inputSchema: subagentSchema,
    execute: async ({ description, prompt, subagent: type }, options) => {
      const id = crypto.randomUUID();
      // parentToolCallId 用 SDK 派给这次调用的 toolCallId —— 子代理进程消息、SSE 帧、
      // 主对话里的卡片三者靠它一对一归位。SDK 总会有,兜底只是防御。
      const parentToolCallId = options?.toolCallId ?? `task-${id}`;

      const result = await ctx.runFork({
        taskId: id,
        parentToolCallId,
        subagentType: type ?? "explorer",
        description,
        prompt,
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {})
      });

      return result.text;
    }
  });

  return [subagent];
};
