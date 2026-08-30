import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import { DrizzlePlanRepository } from "../../../apps/server/src/db/repositories/plan-repository.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/db/repositories/session-repository.js";
import { DrizzleWorkspaceRepository } from "../../../apps/server/src/db/repositories/workspace-repository.js";
import { createPlanGateStore } from "../../../apps/server/src/services/plan-gate/index.js";

const tempDirs: string[] = [];
let db: AppDatabase | undefined;

afterEach(async () => {
  if (db) closeDb(db);
  db = undefined;
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

const setup = async () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);

  const root = await mkdtemp(path.join(os.tmpdir(), "eva-plan-gate-"));
  tempDirs.push(root);

  new DrizzleSessionRepository(db).create({ id: "s1", title: "test" });
  new DrizzleWorkspaceRepository(db).create({ id: "w1", name: "repo", path: root });

  const store = createPlanGateStore({
    db,
    sessionId: "s1",
    workspace: { id: "w1", root }
  });

  return { root, store, repo: new DrizzlePlanRepository(db) };
};

describe("plan-gate store", () => {
  it("enter 建 active 行 + 空 current.md + .eva/.gitignore；重复 enter 报错", async () => {
    const { root, store, repo } = await setup();

    const handle = await store.enter();
    expect(repo.findActive("s1")?.id).toBe(handle.planId);
    expect(await readFile(handle.planPath, "utf-8")).toBe("");
    expect(await readFile(path.join(root, ".eva", ".gitignore"), "utf-8")).toBe("plan-gate/\n");

    await expect(store.enter()).rejects.toThrow("already active");
  });

  it("recordRevision 定版并 bump；approve 改 status", async () => {
    const { store, repo } = await setup();
    const handle = await store.enter();

    expect(await store.readPlan(handle)).toBe("");
    await expect(store.recordRevision(handle)).resolves.toBe(1);
    expect(repo.findById(handle.planId)?.revisionCount).toBe(1);

    const revisionPath = handle.planPath.replace("current.md", "revisions/v1.md");
    expect((await stat(revisionPath)).isFile()).toBe(true);

    await store.approve(handle);
    expect(repo.findById(handle.planId)?.status).toBe("approved");
    expect(repo.findActive("s1")).toBeUndefined();
  });
});
