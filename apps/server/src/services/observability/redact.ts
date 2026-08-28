import { sha256Hex } from "./canonical.js";

/**
 * 持久化与导出前的最小脱敏底线(设计文档 §7.2,不多做)。
 *
 * - 键名命中敏感词 → 值整个替换为 "[REDACTED]";
 * - 字符串里的 Bearer / sk- 样式凭据 → 就地替换;
 * - 单字段超 16 KiB(仅 redacted 档)→ 截断,存 hash + 原始字节数 + truncated;
 * - full 只表示保留完整业务正文(不截断),凭据规则永远生效;
 * - 脱敏器自身异常 → 该字段变 "[redaction failed]",绝不回退保存原文。
 *
 * PEM、JWT、银行卡、邮箱、手机号、bash heredoc、MCP per-tool allowlist 不进第一版。
 */
export type CaptureLevel = "off" | "redacted" | "full";

export const REDACTED = "[REDACTED]";
export const REDACTION_FAILED = "[redaction failed]";
export const MAX_FIELD_BYTES = 16 * 1024;

/**
 * 键名归一化后精确匹配(小写、去 - 和 _)。apiKey / api_key / API-Key 同归 apikey。
 * 刻意不做子串匹配:"token" 子串会把 inputTokens/cacheWriteTokens 这类用量字段
 * 全灭掉。复合变体(accessToken 等)与 §7.2 的 PEM/JWT 一样,发现真实泄漏样本再加。
 */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "apikey",
  "token",
  "password",
  "secret",
  "cookie",
  "setcookie",
  "privatekey"
]);

const normalizeKey = (key: string): string =>
  key.toLowerCase().replace(/[-_\s]/g, "");

const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEYS.has(normalizeKey(key));

/** "Bearer abc.def" → "Bearer [REDACTED]";保留 Bearer 前缀,让读者知道这里曾是个 token。 */
const BEARER_PATTERN = /\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/g;
/** OpenAI / Anthropic 风格的 sk- key。阈值放到 3,宁枉勿纵。 */
const SK_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{3,}\b/g;

export interface TruncatedField {
  readonly truncated: true;
  readonly originalBytes: number;
  readonly sha256: string;
  readonly preview: string;
}

const truncateString = (value: string): string | TruncatedField => {
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= MAX_FIELD_BYTES) {
    return value;
  }
  // 按字节切再把截断处可能残缺的 UTF-8 序列交给 decoder 兜底(产出 ,可接受)。
  const preview = Buffer.from(value, "utf8").subarray(0, MAX_FIELD_BYTES).toString("utf8");
  return {
    truncated: true,
    originalBytes,
    sha256: sha256Hex(value),
    preview
  };
};

const redactString = (value: string, level: Exclude<CaptureLevel, "off">): unknown => {
  const scrubbed = value
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(SK_KEY_PATTERN, REDACTED);
  // full 档保留完整业务正文,不截断;凭据规则上面已经生效。
  return level === "redacted" ? truncateString(scrubbed) : scrubbed;
};

const walk = (value: unknown, level: Exclude<CaptureLevel, "off">, seen: WeakSet<object>): unknown => {
  if (typeof value === "string") {
    return redactString(value, level);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error("circular structure in payload");
    }
    seen.add(value);
    try {
      return value.map((item) => walkField(item, level, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      throw new Error("circular structure in payload");
    }
    seen.add(value);
    try {
      const out: Record<string, unknown> = {};
      // 逐 key 读值:Object.entries 会一次性触发所有 getter,一个炸全灭;
      // 逐 key + try 才能只把炸掉的那个字段换成占位符。
      for (const key of Object.keys(value)) {
        if (isSensitiveKey(key)) {
          out[key] = REDACTED;
          continue;
        }
        let fieldValue: unknown;
        try {
          fieldValue = (value as Record<string, unknown>)[key];
        } catch {
          out[key] = REDACTION_FAILED;
          continue;
        }
        out[key] = walkField(fieldValue, level, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return value;
};

/** 字段级兜底:脱敏器自身抛异常时丢弃整个字段,绝不回退保存原文。 */
const walkField = (value: unknown, level: Exclude<CaptureLevel, "off">, seen: WeakSet<object>): unknown => {
  try {
    return walk(value, level, seen);
  } catch {
    return REDACTION_FAILED;
  }
};

/**
 * 递归脱敏一个 payload。level="off" 不在这里处理 —— recorder 直接落 "{}",
 * 连遍历都不做。
 */
export const redactValue = (value: unknown, level: Exclude<CaptureLevel, "off">): unknown =>
  walkField(value, level, new WeakSet());
