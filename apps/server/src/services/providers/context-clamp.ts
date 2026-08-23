import type { AppDatabase } from "../../db/index.js";
import {
  findStoredProviderById,
  updateProvider
} from "./provider-repository.js";
import type { Encryptor } from "../crypto/encryptor.js";
import type { ProviderModel } from "@eva/shared";

/** T38: 钳制下限 —— 同一模型反复超限也不能钳到不可用(契约:r9/00-overview §3.2)。 */
export const MIN_CONTEXT_WINDOW = 8_000;

/**
 * 钳到 observed 的 90%(留 10% 余量,因为 observed 是「触发超限时的量」,真实上限略低于报错点)。
 * 只在「真实 context_window_exceeded / prompt_too_long」时被调(reactive 路径),估算超限不钳。
 */
export const computeClampedContextWindow = (observedTokens: number): number =>
  Math.max(MIN_CONTEXT_WINDOW, Math.floor(observedTokens * 0.9));

export interface ClampResult {
  readonly clamped: boolean;
  readonly oldContextWindow?: number;
  readonly newContextWindow?: number;
}

/**
 * T38 上下文钳制学习:模型真实报超限 → 把它的 capabilities.contextWindow 永久钳小写 DB。
 *
 * 幂等契约:
 * - 只在新值 < 现值时才钳(不越钳越大,也不震荡);
 * - 现值缺省(模型没登记 contextWindow)时不钳 —— 没有「虚高」可修,缺省值由 policy 默认兜;
 * - 命中下限 MIN_CONTEXT_WINDOW 后不再继续往下。
 *
 * 写回 models 与 availableModels 两处同 modelId(model-resolver 查找顺序 models→availableModels→builtin,
 * builtin 在代码里钳不到也不该钳)。
 */
export const clampContextWindow = (
  db: AppDatabase,
  args: { providerId: string; modelId: string; observedTokens: number },
  encryptor?: Encryptor
): ClampResult => {
  const provider = findStoredProviderById(db, args.providerId, encryptor);
  if (!provider) {
    return { clamped: false };
  }

  const target = computeClampedContextWindow(args.observedTokens);

  const clampList = (
    list: readonly ProviderModel[] | undefined
  ): { list: ProviderModel[]; old: number | undefined; changed: boolean } => {
    let old: number | undefined;
    const next = (list ?? []).map((m) => {
      if (m.id !== args.modelId) return m;
      const current = m.capabilities?.contextWindow;
      if (current === undefined) return m; // 没登记不钳(缺省值由 policy 兜)
      old = current;
      if (target >= current) return m; // 不会变更小 → 不钳(幂等/反震荡)
      return { ...m, capabilities: { ...m.capabilities, contextWindow: target } };
    });
    return { list: next, old, changed: old !== undefined && target < old };
  };

  const models = clampList(provider.models);
  const available = clampList(provider.availableModels);
  const oldContextWindow = models.old ?? available.old;
  const changed = models.changed || available.changed;

  if (!changed || oldContextWindow === undefined) {
    return { clamped: false };
  }

  updateProvider(
    db,
    args.providerId,
    {
      ...(provider.models !== undefined ? { models: models.list } : {}),
      ...(provider.availableModels !== undefined
        ? { availableModels: available.list }
        : {})
    },
    encryptor
  );

  return { clamped: true, oldContextWindow, newContextWindow: target };
};
