import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * apiKey 落库加密的边界接口。
 *
 * 密文格式(前缀即版本):
 *   enc:v1:<base64(iv || ciphertext || tag)>   ← AES-256-GCM,iv 12B 随机,tag 16B
 *   plain:<原文>                                ← 加密不可用时的显式降级
 *   <无前缀>                                    ← 历史明文(迁移前写入的行)
 *
 * 读路径三种都要能解(后向兼容);写路径只写 enc:v1: / plain:,
 * 绝不新写无前缀明文 —— 新写入的每一行都要宣告自己的形态。
 */
export interface Encryptor {
  /** 加密失败(不该发生,GCM 无失败分支)时不降级 —— 抛错,别静默写明文。 */
  encrypt(plain: string): string;
  /**
   * 三种形态全解;密文损坏/key 不对 → 抛错。
   * 绝不静默返回密文本身 —— 那会把 "enc:v1:..." 当 apiKey 发去 provider,
   * 401 的报错文案完全看不出真因(坑 4)。
   */
  decrypt(stored: string): string;
}

const ENC_PREFIX = "enc:v1:";
const PLAIN_PREFIX = "plain:";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** 加密可用时的唯一实现。key 注入,不碰文件系统(文件的事在 secret-key.ts)。 */
export class AesGcmEncryptor implements Encryptor {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`AES-256-GCM key 必须 ${KEY_BYTES} 字节,收到 ${key.length}`);
    }
    this.#key = key;
  }

  encrypt(plain: string): string {
    if (plain === "") return ""; // 空串 = "没配 key",加密会变成非空密文 → hasApiKey 语义崩坏(坑 1)
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENC_PREFIX}${Buffer.concat([iv, ciphertext, tag]).toString("base64")}`;
  }

  decrypt(stored: string): string {
    if (stored === "") return "";
    if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
    if (!stored.startsWith(ENC_PREFIX)) return stored; // 历史明文兼容

    const blob = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
    if (blob.length < IV_BYTES + 16) {
      throw new Error("apiKey 密文长度不合法(小于 iv+tag)");
    }
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(blob.length - 16);
    const ciphertext = blob.subarray(IV_BYTES, blob.length - 16);

    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAuthTag(tag);
    // GCM tag 校验失败 → final() 抛错,向上抛(调用方按"key 不可用"处理)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

/**
 * 明文直通(缺省形态):密钥文件读不出时的降级,与"无加密版"行为完全一致。
 * 显式存在的意义:调用方不用写 `encryptor?.encrypt(x) ?? x` 这种空值分支。
 */
export class IdentityEncryptor implements Encryptor {
  encrypt(plain: string): string {
    return plain;
  }

  decrypt(stored: string): string {
    return stored;
  }
}
