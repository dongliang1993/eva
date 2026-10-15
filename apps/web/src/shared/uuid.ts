/**
 * UUID v4 —— crypto.randomUUID 的安全上下文兜底。
 *
 * 为什么存在:vite dev server 配了 host: true,用局域网 IP(http://192.168.x.x)
 * 打开页面时浏览器判定为非安全上下文,crypto.randomUUID 是 undefined,发消息直接
 * TypeError(getRandomValues 在非安全上下文依然可用)。生产构建走 https/localhost,
 * 原生路径永远优先;手搓路径只在原生缺失时触达。
 */

const HEX = "0123456789abcdef";
/** 16 字节 = 128 位 UUID;v4 由版本位 + variant 位表达。 */
const UUID_BYTES = 16;

/** 按 RFC 4122 语义把熵字节拼成 UUID v4 文本。 */
const formatUuidV4 = (bytes: Uint8Array): string => {
  // 版本位(第 7 字节高半位)= 4:v4。
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  // variant 位(第 9 字节高两位)= 10:RFC 4122。
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => HEX[byte >> 4]! + HEX[byte & 0x0f]!);
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
};

/** UUID v4;原生 crypto.randomUUID 缺失(非安全上下文)时用 getRandomValues 兜底。 */
export const randomUUID = (): string => {
  const native = globalThis.crypto?.randomUUID;
  if (typeof native === "function") {
    return native.call(globalThis.crypto);
  }

  const bytes = new Uint8Array(UUID_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return formatUuidV4(bytes);
};
