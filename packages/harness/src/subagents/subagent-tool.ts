import { z } from "zod";

import { buildTool, type AgentTool } from "../tools.js";
import type { TaskStore } from "./task-store.js";

/**
 * server 层注入的 fork 边界。它知道 sessionId/depth/工具槽模型/角色白名单,
 * 所以 create(记事实)和 settle(写终态)都在那边 —— 本工具只管编排。
 *
 * - background=true:立刻带 taskId 返回(fork 已在后台跑,结果日后经通知推给父级)
 * - background=false:等跑完,text 是子代理交付的结论(阀2:绝不含中间工具输出)
 */
export type ForkRunner = (invocation: {
  readonly background: boolean;
  readonly prompt: string;
  readonly subagentType: string;
  readonly description: string;
  readonly taskId: string;
  readonly parentToolCallId: string;
}) => Promise<{ readonly taskId?: string; readonly text?: string }>;

export interface SubagentToolContext {
  readonly taskStore: TaskStore;
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
  run_in_background: z.boolean().optional().describe(
    "Whether to run in the background and return a durable subagent id immediately. " +
    "Defaults to true. Set false to wait for the result when your next action depends on it."
  )
});

/**
 * 唯一的子代理原语(S7 push 模型)。
 *
 * 刻意**没有** join / 查询工具:结果由 runtime 在子代理 report 时注入本轮对话
 * (见 types.ts 的 SubagentNotice)。给模型一个可反复调用的查询接口,它就会轮询 ——
 * 实测会刷出一屏 "still running" 而拿不到结果。所以这里从结构上不提供那个接口。
 */
export const createSubagentTool = (ctx: SubagentToolContext): readonly AgentTool[] => {
  const subagent = buildTool({
    name: "subagent",
    description: [
      "Delegate a self-contained task to a subagent (a separate agent that works in its own " +
      "context) to offload focused, independent work — research, a scoped analysis — so it does " +
      "not consume this conversation's context.",
      "The subagent returns its result, not its intermediate steps. Give it a complete, " +
      "standalone prompt: it does not see this conversation.",
      "This tool runs in the background by default and immediately returns a subagent id. " +
      "When that run reports, the runtime delivers its outcome to you automatically — there is " +
      "no tool to poll and no need to ask for it.",
      "Set run_in_background: false only when your next action depends on receiving the result."
    ].join("\n"),
    schema: subagentSchema,
    execute: async ({ description, prompt, subagent: type, run_in_background }, options) => {
      const id = newTaskId();
      // parentToolCallId 用 SDK 派给这次调用的 toolCallId —— 子代理进程消息、SSE 帧、
      // 主对话里的卡片三者靠它一对一归位。SDK 总会有,兜底只是防御。
      const parentToolCallId = options?.toolCallId ?? `task-${id}`;
      const background = run_in_background !== false;

      const result = await ctx.runFork({
        taskId: id,
        parentToolCallId,
        subagentType: type ?? "explorer",
        description,
        prompt,
        background
      });

      if (!background) {
        return result.text ?? `Subagent ${id} finished with no reported result.`;
      }

      // 措辞刻意不提"轮询/查询"这类词 —— 连否定式提及都会给模型种下那个念头。
      // 只陈述事实:结果会自己来,现在去干别的。
      return `Started subagent ${id} (${description}). Its result will be delivered to you ` +
        "automatically as soon as it reports. Continue with other work in the meantime.";
    }
  });

  return [subagent];
};

/** 工具内本地生成 fork 号 —— server 会用它做 create 的 id。 */
const newTaskId = (): string => {
  const rand = Math.random().toString(36).slice(2, 10);
  return `t_${Date.now().toString(36)}_${rand}`;
};
