import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";
import { DrizzleWorkspaceRepository } from "../apps/server/src/db/repositories/workspace-repository.js";
import { DrizzleSessionRepository } from "../apps/server/src/db/repositories/session-repository.js";
import type { Session } from "../apps/server/src/db/repositories/types.js";
import { assertUsableWorkspacePath, UnusableWorkspacePathError } from "../apps/server/src/services/workspaces/workspace-guard.js";
import { WorkspaceStore, resolveWorkspaceForSession } from "../apps/server/src/services/workspaces/workspace-store.js";
import { loadProjectDocsSection } from "../apps/server/src/services/workspaces/project-docs.js";

const tmpDirs: string[] = [];

const makeDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "eva-ws-"));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("assertUsableWorkspacePath", () => {
  it("接受一个存在的普通目录,返回绝对路径", () => {
    const dir = makeDir();
    expect(assertUsableWorkspacePath(dir)).toBe(path.resolve(dir));
  });

  it("相对路径被解析成绝对路径", () => {
    const dir = makeDir();
    const rel = path.relative(process.cwd(), dir);
    expect(assertUsableWorkspacePath(rel)).toBe(path.resolve(dir));
  });

  it("空串被拒", () => {
    expect(() => assertUsableWorkspacePath("  ")).toThrow();
  });

  it("不存在的目录被拒", () => {
    const nonexistent = path.join(os.tmpdir(), "eva-definitely-missing", "nope");
    expect(() => assertUsableWorkspacePath(nonexistent)).toThrow();
  });

  it("文件(非目录)被拒", () => {
    const dir = makeDir();
    const file = path.join(dir, "not-a-dir.txt");
    writeFileSync(file, "x");
    expect(() => assertUsableWorkspacePath(file)).toThrow();
  });

  it("家目录被拒", () => {
    expect(() => assertUsableWorkspacePath(os.homedir())).toThrow();
  });

  it("文件系统根被拒", () => {
    expect(() => assertUsableWorkspacePath("/")).toThrow();
  });
});

describe("WorkspaceStore + resolveWorkspaceForSession", () => {
  let db: AppDatabase;
  let store: WorkspaceStore;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    store = new WorkspaceStore(new DrizzleWorkspaceRepository(db));
  });

  afterEach(() => {
    closeDb(db);
  });

  const sessionWith = (workspaceId: string | null): Session => ({
    id: "session-1",
    title: "t",
    model: null,
    origin: "chat",
    metadata: "{}",
    workspaceId,
    createdAt: "",
    updatedAt: ""
  });

  it("同一目录不同写法只有一条记录", () => {
    const dir = makeDir();
    const first = store.add({ path: dir });
    const second = store.add({ path: dir + path.sep });

    expect(second.id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
  });

  it("add 非法路径抛 UnusableWorkspacePathError", () => {
    expect(() => store.add({ path: "/" })).toThrow(UnusableWorkspacePathError);
    expect(() => store.add({ path: os.homedir() })).toThrow(UnusableWorkspacePathError);
  });

  it("会话未绑工作区 → undefined", () => {
    const logger = { warn: vi.fn() };
    expect(resolveWorkspaceForSession(store, sessionWith(null), logger)).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("绑了但目录已删 → undefined 且 logger.warn 被调用", () => {
    const dir = makeDir();
    const ws = store.add({ path: dir });
    rmSync(dir, { recursive: true, force: true });

    const logger = { warn: vi.fn() };
    expect(resolveWorkspaceForSession(store, sessionWith(ws.id), logger)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("删除工作区后会话 workspaceId 为 NULL 且会话还在(FK SET NULL)", () => {
    const dir = makeDir();
    const ws = store.add({ path: dir });
    const session = sessionWith(ws.id);

    // 建一条真实会话再删工作区,验证 FK ON DELETE SET NULL。
    new DrizzleSessionRepository(db).create({ id: session.id, workspaceId: ws.id });

    store.remove(ws.id);

    const after = new DrizzleSessionRepository(db).findById(session.id);
    expect(after).toBeDefined();
    expect(after?.workspaceId).toBeNull();
  });
});

describe("loadProjectDocsSection", () => {
  it("无文件 → undefined", async () => {
    const dir = makeDir();
    expect(await loadProjectDocsSection(dir)).toBeUndefined();
  });

  it("有 CLAUDE.md → body 含其内容", async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, "CLAUDE.md"), "所有回复以 🐟 开头");
    const section = await loadProjectDocsSection(dir);
    expect(section?.body).toContain("所有回复以 🐟 开头");
  });

  it("有 AGENTS.md 与 CLAUDE.md → 都注入", async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, "CLAUDE.md"), "claude rule");
    writeFileSync(path.join(dir, "AGENTS.md"), "agents rule");
    const section = await loadProjectDocsSection(dir);
    expect(section?.body).toContain("claude rule");
    expect(section?.body).toContain("agents rule");
  });

  it("超 16KB → 含截断标记", async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, "CLAUDE.md"), "x".repeat(20 * 1024));
    const section = await loadProjectDocsSection(dir);
    expect(section?.body).toContain("truncated at 16KB");
  });
});