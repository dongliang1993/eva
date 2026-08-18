/**
 * 模型引用的唯一合法形状是 `providerId:modelId`。产生引用的地方(UI 模型选择器、
 * listModelSummaries)本来就产出 qualified id,这里不再做字符串前缀猜测。
 *
 * 为什么删掉 startsWith("claude")/"gpt"/"o" 前缀猜测:猜错的表现是静默用另一个
 * provider 的 key 去打另一个端点,报错信息指向完全无关的地方。宁可在入口拒绝
 * —— 所以 resolveModelSlot 拿到不含 `:` 的引用时直接 ok:false。
 */
export const splitQualifiedModelId = (
  value: string
): { providerId: string; modelId: string } | undefined => {
  const separatorIndex = value.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
    return undefined;
  }

  return {
    providerId: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 1)
  };
};

/** 已知 provider id 的列表场景:拼出 qualified id,不做任何猜测。 */
export const qualifyProviderModelId = (
  providerId: string,
  modelId: string
): string => (modelId.startsWith(`${providerId}:`) ? modelId : `${providerId}:${modelId}`);