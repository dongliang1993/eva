import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const KEY_BYTES = 32;

/**
 * apiKey 加密密钥的提供者。
 *
 * 为什么不用 Electron safeStorage:server 有两条运行路径(桌面 UtilityProcess
 * 子进程 / 纯 server `tsx` 开发路径),后者没有父进程可桥。自管密钥在两条
 * 路径上行为一致;代价是 key 与 DB 同在 ~/.eva/ —— 防"只拷走 eva.db",
 * 不防"整目录被端"(威胁模型见 r5 00-overview §4,可接受)。
 *
 * 首次启动生成 32 字节随机 key,base64 一行写入,文件权限 0600。
 *
 * 读取失败(文件损坏/权限不对/长度不对)→ 返回 undefined = 加密不可用,
 * 调用方降级 plain: 并打 warning。绝不为"读不出 key"抛错 —— 那会让整个
 * provider 体系在 key 文件损坏时全灭,而降级明文至少能用(与 Alma 同款
 * 降级哲学,docs 04 §8.3.2)。
 */
export const loadSecretKey = (keyPath: string): Buffer | undefined => {
  try {
    if (existsSync(keyPath)) {
      const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
      // base64 对非法输入很宽容(静默跳过坏字符),必须验长度才算数
      return key.length === KEY_BYTES ? key : undefined;
    }

    const key = randomBytes(KEY_BYTES);
    mkdirSync(path.dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
    return key;
  } catch {
    return undefined;
  }
};
