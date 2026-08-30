import type { AppDatabase } from "../../db/index.js";
import {
  UsageRecordRepository,
  type UsageStatsRow
} from "./usage-record-repository.js";

// 行形状是这一层的出参契约,route 与前端都按它读 —— 从这里再导一次,
// 免得 route 为了一个类型去 import db/repositories(那正是 routes-no-db 要拦的)。
export type { UsageStatsRow };

export interface UsageStatsQuery {
  readonly fromDate: string;
  readonly toDate: string;
  readonly providerId?: string;
  readonly modelId?: string;
}

export interface UsageApi {
  /** 按 date × model 聚合的 token 用量。行数小,总计由调用方累加。 */
  statsByDateAndModel(query: UsageStatsQuery): readonly UsageStatsRow[];
}

export const createUsageApi = (deps: {
  readonly usageRecords: UsageRecordRepository;
}): UsageApi => ({
  statsByDateAndModel: (query) => deps.usageRecords.sumByDateAndModel(query)
});
