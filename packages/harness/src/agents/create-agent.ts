import { withApproval } from "../tools/with-approval.js";
import { LeadAgent } from "./lead-agent.js";
import type { CreateAgentOptions, Agent } from "./types.js";

export const createAgent = (options: CreateAgentOptions): Agent => {
  const { requestApproval, ...rest } = options;

  // 危险工具统一在 createAgent 一层包装 execute。
  // 不再把 requestApproval 传给 LeadAgent —— 审批逻辑完全收敛到 withApproval。
  // (子代理 fork-join 半成品已在 T4 移除,S7 会从零实现带独立流式通道与消息落库的版本。)
  const tools = requestApproval
    ? (rest.tools ?? []).map((t) => withApproval(t, requestApproval))
    : rest.tools;

  return new LeadAgent({
    model: rest.model,
    ...(tools !== undefined ? { tools } : {}),
    ...(rest.systemPrompt !== undefined
      ? { systemPrompt: rest.systemPrompt }
      : {}),
    ...(rest.maxSteps !== undefined ? { maxSteps: rest.maxSteps } : {}),
    ...(rest.observer !== undefined ? { observer: rest.observer } : {}),
    ...(rest.contextPolicy !== undefined
      ? { contextPolicy: rest.contextPolicy }
      : {}),
    ...(rest.callSettings !== undefined ? { callSettings: rest.callSettings } : {}),
    ...(rest.repairModel !== undefined ? { repairModel: rest.repairModel } : {})
  });
};