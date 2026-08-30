import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryFileStore } from "../../../apps/server/src/services/memory/memory-file-store.js";

const tempDirs: string[] = [];

const createTempRoot = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eva-memfile-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

const fileName = (root: string, rel: string): string => path.join(root, rel);

describe("MemoryFileStore.readLongTermMemoryFile", () => {
  it("returns undefined when MEMORY.md does not exist", async () => {
    const store = new MemoryFileStore(await createTempRoot());
    expect(await store.readFile("MEMORY.md")).toBeUndefined();
  });

  it("reads the joined file under the root", async () => {
    const root = await createTempRoot();
    await writeFile(fileName(root, "MEMORY.md"), "hello 汉堡", "utf-8");
    const store = new MemoryFileStore(root);
    expect(await store.readFile("MEMORY.md")).toBe("hello 汉堡");
  });
});

describe("MemoryFileStore path guard (docs 05 坑①)", () => {
  it("rejects directory traversal", async () => {
    const store = new MemoryFileStore(await createTempRoot());
    await expect(store.readFile("../../etc/passwd")).rejects.toThrow();
  });

  it("rejects absolute paths", async () => {
    const store = new MemoryFileStore(await createTempRoot());
    await expect(store.readFile("/etc/passwd")).rejects.toThrow();
  });

  it("rejects traversal through memory/ prefix", async () => {
    const store = new MemoryFileStore(await createTempRoot());
    await expect(store.readFile("memory/../../x")).rejects.toThrow();
  });
});

describe("MemoryFileStore.list", () => {
  it("returns MEMORY.md plus memory/*.md sorted newest first", async () => {
    const root = await createTempRoot();
    await writeFile(fileName(root, "MEMORY.md"), "long term", "utf-8");
    await mkdir(fileName(root, "memory"), { recursive: true });
    await writeFile(fileName(root, "memory/2026-08-18.md"), "a", "utf-8");
    await writeFile(fileName(root, "memory/2026-08-19.md"), "b", "utf-8");
    // 非 .md / 嵌套文件不算。
    await writeFile(fileName(root, "memory/readme.txt"), "c", "utf-8");

    const store = new MemoryFileStore(root);
    const listed = await store.list();

    expect(listed).toEqual(["MEMORY.md", "memory/2026-08-19.md", "memory/2026-08-18.md"]);
  });
});

describe("MemoryFileStore.appendDailyNote", () => {
  it("creates the file with a heading when missing", async () => {
    const root = await createTempRoot();
    const store = new MemoryFileStore(root);
    await store.appendDailyNote("2026-08-19", "决定先做子代理");

    const content = await store.readFile("memory/2026-08-19.md");
    expect(content).toContain("# 2026-08-19");
    expect(content).toContain("决定先做子代理");
  });

  it("appends without duplicating the heading when the file exists", async () => {
    const root = await createTempRoot();
    const store = new MemoryFileStore(root);
    await store.appendDailyNote("2026-08-19", "第一条");
    await store.appendDailyNote("2026-08-19", "第二条");

    const content = (await store.readFile("memory/2026-08-19.md"))!;
    expect(content.match(/# 2026-08-19/g)).toHaveLength(1);
    expect(content).toContain("第一条");
    expect(content).toContain("第二条");
  });
});

describe("MemoryFileStore.writeLongTermMemory", () => {
  it("replaces the whole file", async () => {
    const root = await createTempRoot();
    const store = new MemoryFileStore(root);
    await store.writeLongTermMemory("旧");
    await store.writeLongTermMemory("新");
    expect(await store.readFile("MEMORY.md")).toBe("新");
  });
});

describe("MemoryFileStore concurrent writes", () => {
  it("serializes with the in-process write lock (no interleaving)", async () => {
    const root = await createTempRoot();
    const store = new MemoryFileStore(root);

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.appendDailyNote("2026-08-19", `entry-${i}`))
    );

    const content = (await store.readFile("memory/2026-08-19.md"))!;
    for (let i = 0; i < 10; i++) {
      expect(content).toContain(`entry-${i}`);
    }
    // 每个条目独立成行 —— 无截断/交错。
    expect(content.split("\n").filter((l) => l.startsWith("entry-")).length).toBe(10);
  });
});
