import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { initDb, migrateDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import {
  AesGcmEncryptor,
  IdentityEncryptor
} from "../../../apps/server/src/infrastructure/crypto/encryptor.js";
import { loadSecretKey } from "../../../apps/server/src/infrastructure/crypto/secret-key.js";
import {
  createProvider,
  findStoredProviderById,
  updateProvider
} from "../../../apps/server/src/modules/providers/index.js";

const TEST_KEY = randomBytes(32);

describe("AesGcmEncryptor 三形态", () => {
  const enc = new AesGcmEncryptor(TEST_KEY);

  it("round-trip:encrypt → enc:v1: 前缀 → decrypt 回原值", () => {
    const stored = enc.encrypt("sk-ant-xxx");
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(enc.decrypt(stored)).toBe("sk-ant-xxx");
  });

  it("plain: 前缀 → 剥前缀返回", () => {
    expect(enc.decrypt("plain:sk-xxx")).toBe("sk-xxx");
  });

  it("无前缀(历史明文) → 原样返回", () => {
    expect(enc.decrypt("sk-legacy-plain")).toBe("sk-legacy-plain");
  });

  it("空串直通(不加密、不解密)", () => {
    expect(enc.decrypt("")).toBe("");
  });

  it("两次 encrypt 同一原文 → 密文不同(iv 随机)", () => {
    expect(enc.encrypt("same")).not.toBe(enc.encrypt("same"));
  });

  it("篡改密文一个字符 → decrypt 抛错(GCM tag 校验)", () => {
    const stored = enc.encrypt("sk-ant-xxx");
    const tail = stored.slice(-1);
    const tampered = `${stored.slice(0, -1)}${tail === "A" ? "B" : "A"}`;
    expect(() => enc.decrypt(tampered)).toThrow();
  });

  it("别的 key 加密 → 本 key 解不开 → 抛错", () => {
    const foreign = new AesGcmEncryptor(randomBytes(32)).encrypt("sk-x");
    expect(() => enc.decrypt(foreign)).toThrow();
  });
});

describe("IdentityEncryptor", () => {
  it("round-trip = 原文", () => {
    const id = new IdentityEncryptor();
    expect(id.encrypt("sk-x")).toBe("sk-x");
    expect(id.decrypt("sk-x")).toBe("sk-x");
  });
});

describe("loadSecretKey", () => {
  const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), "eva-key-"));

  it("路径不存在 → 生成 32 字节新 key 并写文件,权限 0600", () => {
    const keyPath = path.join(tmp(), ".secret-key");
    const key = loadSecretKey(keyPath);

    expect(key).toBeDefined();
    expect(key!.length).toBe(32);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it("已存在 → 读出同一个 key", () => {
    const keyPath = path.join(tmp(), ".secret-key");
    const first = loadSecretKey(keyPath);
    const second = loadSecretKey(keyPath);

    expect(second).toEqual(first);
  });

  it("文件内容损坏(非 base64) → undefined(不抛)", () => {
    const keyPath = path.join(tmp(), ".secret-key");
    writeFileSync(keyPath, "!!!not-base64!!!", { mode: 0o600 });

    expect(loadSecretKey(keyPath)).toBeUndefined();
  });

  it("文件内容长度不对(base64 但非 32 字节) → undefined", () => {
    const keyPath = path.join(tmp(), ".secret-key");
    writeFileSync(keyPath, Buffer.from("short").toString("base64"), { mode: 0o600 });

    expect(loadSecretKey(keyPath)).toBeUndefined();
  });
});

describe("provider-repository 加解密边界", () => {
  const setup = () => {
    const db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    return db;
  };
  const aes = new AesGcmEncryptor(TEST_KEY);

  /** 绕开 ORM 直接看落库原文(读路径会解密,看不到密文)。 */
  const rawApiKey = (db: AppDatabase, id: string): string => {
    const sqlite = (db as unknown as { $client: Database.Database }).$client;
    const row = sqlite
      .prepare("SELECT api_key FROM providers WHERE id = ?")
      .get(id) as { api_key: string };
    return row.api_key;
  };

  it("createProvider 带 key → DB 里 enc:v1: 前缀,读出透明解密", () => {
    const db = setup();
    const created = createProvider(db, {
      name: "Enc Test",
      type: "openai",
      apiKey: "sk-create"
    }, aes);

    expect(rawApiKey(db, created.id).startsWith("enc:v1:")).toBe(true);

    expect(findStoredProviderById(db, created.id, aes)?.apiKey).toBe("sk-create");
  });

  it("updateProvider 换 key → DB 里密文,读出明文", () => {
    const db = setup();
    const created = createProvider(db, { name: "Upd Test", type: "openai" });
    updateProvider(db, created.id, { apiKey: "sk-x" }, aes);

    expect(rawApiKey(db, created.id).startsWith("enc:v1:")).toBe(true);
    expect(findStoredProviderById(db, created.id, aes)?.apiKey).toBe("sk-x");
  });

  it("不传 encryptor → 明文直通(既有行为回归)", () => {
    const db = setup();
    const created = createProvider(db, {
      name: "Plain Test",
      type: "openai",
      apiKey: "sk-plain"
    });

    expect(rawApiKey(db, created.id)).toBe("sk-plain");
    expect(findStoredProviderById(db, created.id)?.apiKey).toBe("sk-plain");
  });

  it("clearApiKey → DB 里空串,读出空串(空串不加密)", () => {
    const db = setup();
    const created = createProvider(db, {
      name: "Clear Test",
      type: "openai",
      apiKey: "sk-to-clear"
    }, aes);
    updateProvider(db, created.id, { clearApiKey: true }, aes);

    expect(rawApiKey(db, created.id)).toBe("");
    expect(findStoredProviderById(db, created.id, aes)?.apiKey).toBe("");
  });

  it("懒迁移:update 不动 key → 历史明文行保持明文", () => {
    const db = setup();
    const created = createProvider(db, {
      name: "Lazy Test",
      type: "openai",
      apiKey: "sk-legacy"
    }); // 无 encryptor → 明文落库(模拟历史行)

    updateProvider(db, created.id, { name: "Lazy Renamed" }, aes);

    expect(rawApiKey(db, created.id)).toBe("sk-legacy"); // 仍是明文
    expect(findStoredProviderById(db, created.id, aes)?.apiKey).toBe("sk-legacy"); // 读路径兼容
  });
});
