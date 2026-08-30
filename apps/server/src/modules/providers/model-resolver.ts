import type { ModelSlot, ProviderKind, ProviderType } from "@eva/shared";

import type { AppConfig } from "../../config.js";
import type { AppDatabase } from "../../db/index.js";
import type { Encryptor } from "../../infrastructure/crypto/encryptor.js";
import { findProviderSpec, resolveProviderBaseURL } from "./provider-catalog.js";
import { findStoredProviderById } from "./provider-repository.js";
import {
  loadAppSettings,
  splitQualifiedModelId,
} from "../settings/index.js";

export interface ModelBinding {
  readonly slot: ModelSlot;
  readonly providerId: string;
  readonly providerType: ProviderType;
  readonly kind: ProviderKind;
  readonly qualifiedModelId: string; // "providerId:modelId"
  readonly modelId: string;
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export type ModelResolution =
  | { readonly ok: true; readonly binding: ModelBinding }
  | { readonly ok: false; readonly reason: string };

const toNonEmpty = (value?: string): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

/**
 * override 优先于 settings(用户在 UI 里临时换模型走这条)。
 * 模型标识必须是 `providerId:modelId`,不含 `:` 直接拒绝 —— 不猜 provider。
 *
 * **chat 槽位只认 override,没有任何默认值。** 主对话模型是 per-run 决策:新建
 * thread 时选、聊天中可切换,由请求的 modelId 给,落库进 sessions.model。所以
 * 调用方拿不到 override 时(如会话外的用量查询),要么传会话记录的模型,要么
 * 接受 ok:false 并降级 —— 不许在这里编一个默认模型出来。
 *
 * tool/embedding 槽位仍从 settings 取默认(它们不是 per-run 决策)。
 */
export const resolveModelSlot = (
  db: AppDatabase,
  config: AppConfig,
  slot: ModelSlot,
  override?: string,
  encryptor?: Encryptor
): ModelResolution => {
  const settings = loadAppSettings(db, config);
  // chat 槽位:override 是唯一来源;没给就是没选模型,不回落全局默认。
  const configured =
    slot === "chat"
      ? toNonEmpty(override)
      : toNonEmpty(override) ?? settings.models[slot];

  if (!configured) {
    return { ok: false, reason: `未配置 ${slot} 模型。` };
  }

  const ref = splitQualifiedModelId(configured);
  if (!ref) {
    return {
      ok: false,
      reason: `模型标识必须是 providerId:modelId 形式：${configured}`
    };
  }

  const provider = findStoredProviderById(db, ref.providerId, encryptor);
  if (!provider) {
    return { ok: false, reason: `Provider "${ref.providerId}" 不存在。` };
  }

  const spec = findProviderSpec(provider.type);
  if (!spec) {
    return { ok: false, reason: `不支持的 provider 类型：${provider.type}` };
  }

  if (!provider.enabled) {
    return { ok: false, reason: `Provider "${provider.name}" 未启用。` };
  }

  const apiKey = toNonEmpty(provider.apiKey);
  if (!apiKey) {
    return { ok: false, reason: `Provider "${provider.name}" 缺少 API key。` };
  }

  const baseURL = resolveProviderBaseURL(spec, provider.baseURL);
  if (!baseURL && spec.kind !== "anthropic") {
    return { ok: false, reason: `Provider "${provider.name}" 需要 base URL。` };
  }

  const capabilities =
    provider.models.find((m) => m.id === ref.modelId)?.capabilities
    ?? provider.availableModels.find((m) => m.id === ref.modelId)?.capabilities
    ?? spec.builtinModels.find((m) => m.id === ref.modelId)?.capabilities;

  return {
    ok: true,
    binding: {
      slot,
      providerId: provider.id,
      providerType: provider.type,
      kind: spec.kind,
      qualifiedModelId: configured,
      modelId: ref.modelId,
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(capabilities?.contextWindow !== undefined
        ? { contextWindow: capabilities.contextWindow }
        : {}),
      ...(capabilities?.maxOutputTokens !== undefined
        ? { maxOutputTokens: capabilities.maxOutputTokens }
        : {})
    }
  };
};
