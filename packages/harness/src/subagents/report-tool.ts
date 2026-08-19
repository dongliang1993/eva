import { z } from "zod";

import { buildTool, type AgentTool } from "../tools.js";

/** report 工具把内容交给"启动我的那个 agent"—— 谁是父级由装配方闭包决定,子代理无从选择。 */
export type ReportSink = (output: string) => void;

const reportSchema = z.object({
  output: z.string().min(1).describe(
    "Actionable content for your parent; summarize conclusions and reference relevant shared paths."
  )
});

/**
 * 子代理交付结论的唯一出口(S7 push 模型)。
 *
 * 这是上下文隔离(阀2)的正面表述:父 agent **不会**自动收到子代理的 transcript /
 * 工具输出 / 推理过程,所以"把活干完"本身不等于"交了结果"。子代理必须显式选择
 * 回传什么 —— 由它自己收敛,而不是由 runtime 截取 final text。
 *
 * 允许跑完前多次调用:中途有改变父级下一步决策的发现就先报一次。report 不结束
 * 子代理的回合,也只有直接父级收得到。
 */
export const createReportTool = (onReport: ReportSink): AgentTool =>
  buildTool({
    name: "report",
    description: [
      "Report selected content to the agent that started you.",
      "Call this once before you finish, with a self-contained final result, and earlier for " +
      "progress or findings that change what that agent does next.",
      "That agent shares your workspace but does NOT automatically receive your transcript, " +
      "tool output, or reasoning, so finishing your work is not itself a result.",
      "Reporting does not end your turn or finish your work, and only your direct parent " +
      "receives it.",
      "A failed call may still have arrived, so do not blindly repeat it."
    ].join("\n"),
    schema: reportSchema,
    // 只读语义:它不碰工作区,只把内容递给父级(免审批,与 read_* 同级)。
    readOnly: true,
    execute: async ({ output }) => {
      onReport(output);
      return "Reported to your parent agent.";
    }
  });
