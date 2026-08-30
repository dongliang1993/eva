import type { PlanWeaveService } from "../services/plan-weave/index.js";

/**
 * T46 plan weave —— workspace 级的文件任务图。
 *
 * **与 plan gate 是两个模块**,不要因为名字像就合并(§7.10):plan gate 是会话级审批闸门,
 * 事实源在 DB;plan weave 的事实源是 workspace 里的文件。这个入口只有前者没有后者。
 *
 * 这里不重新声明每个方法 —— service 的方法就是用例,签名一一对应。Wave 4 收模块公开
 * 入口时再决定要不要收窄。
 */
export type PlansApi = PlanWeaveService;

export const createPlansApi = (deps: { readonly planWeave: PlanWeaveService }): PlansApi =>
  deps.planWeave;
