import { createHash } from "node:crypto";

/**
 * canonical JSON:对象键递归排序、无多余空白。
 * hash 稳定性靠它 —— request_snapshot 的同 Run 去重(§4.3)和截断字段的
 * sha256 都要求「同一份内容必然得到同一个字符串」。
 *
 * 语义对齐 JSON.stringify:undefined/函数在对象里被丢弃、在数组里变 null。
 * 非 plain object(Date、Map 等)按 plain object 处理,键为空则序列化成 {} ——
 * ledger payload 都是自己构造的 plain object,不为外来类实例做兼容。
 */
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = normalize((value as Record<string, unknown>)[key]);
      if (normalized !== undefined) {
        out[key] = normalized;
      }
    }
    return out;
  }
  return value;
};

export const canonicalStringify = (value: unknown): string =>
  JSON.stringify(normalize(value)) ?? "null";

export const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");
