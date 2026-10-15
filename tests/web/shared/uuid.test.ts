import { afterEach, describe, expect, it } from "vitest";

import { randomUUID } from "../../../apps/web/src/shared/uuid.js";

/** RFC 4122 UUID v4 文本形态 —— 大小写不敏感,variant 位必须是 10。 */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Object.defineProperty 用的原描述符,afterEach 里还原。 */
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
/** 覆盖前先抓住原对象 —— getter 里再读 globalThis.crypto 会无限递归。 */
const nativeCrypto = globalThis.crypto;

/** 模拟非安全上下文:randomUUID 不在,getRandomValues 仍在。
 *  WebCrypto 方法都在原型链上(实例自身无可枚举属性),{ ...crypto } 展开是空对象 ——
 *  必须用 Object.create 继承原型再遮蔽 randomUUID。
 *  getRandomValues 原生实现要求 this 是真 Crypto(类型检查),mock 里绑回真实实例。 */
const withoutNativeRandomUUID = (): void => {
  Object.defineProperty(globalThis, "crypto", {
    ...cryptoDescriptor,
    get() {
      return Object.create(nativeCrypto, {
        randomUUID: { value: undefined },
        getRandomValues: { value: nativeCrypto.getRandomValues.bind(nativeCrypto) }
      });
    }
  });
};

describe("randomUUID", () => {
  afterEach(() => {
    if (cryptoDescriptor) {
      Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    }
  });

  it("produces spec-shaped UUID v4 strings (native path)", () => {
    expect(randomUUID()).toMatch(UUID_V4_PATTERN);
  });

  it("produces spec-shaped UUID v4 without crypto.randomUUID (insecure context)", () => {
    withoutNativeRandomUUID();

    expect(randomUUID()).toMatch(UUID_V4_PATTERN);
  });

  it("yields distinct ids across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      seen.add(randomUUID());
    }
    expect(seen.size).toBe(64);
  });
});
