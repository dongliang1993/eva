import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, initDb, isVecAvailable, migrateDb } from "../../../apps/server/src/db/index.js";
import { MemoryEmbeddingRepository } from "../../../apps/server/src/modules/memory/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "eva-vec-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("vec table persistence", () => {
  it("向量在重启(重新 migrate)后仍然存在", () => {
    const dbPath = path.join(dir, "eva.db");

    const first = initDb({ dbPath });
    migrateDb(first);
    if (!isVecAvailable()) {
      return; // 环境未装 sqlite-vec → 跳过
    }
    new MemoryEmbeddingRepository(first).upsert("m1", new Float32Array(1024).fill(0.01));
    closeDb(first);

    const second = initDb({ dbPath });
    migrateDb(second); // 关键:第二次 migrate 不许清表

    expect(new MemoryEmbeddingRepository(second).has("m1")).toBe(true);
    closeDb(second);
  });
});