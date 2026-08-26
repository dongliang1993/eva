import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../apps/server/node_modules/fastify";

import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../apps/server/src/db/index.js";
import { DrizzleWorkspaceRepository } from "../apps/server/src/db/repositories/workspace-repository.js";
import { planWeaveDir } from "../apps/server/src/paths.js";
import { registerPlanWeaveRoutes } from "../apps/server/src/routes/plan-weave.js";
import { PlanWeaveService } from "../apps/server/src/services/plan-weave/index.js";
import { WorkspaceStore } from "../apps/server/src/services/workspaces/workspace-store.js";

let app: FastifyInstance;
let db: AppDatabase;
let workspaceRoot: string;

const tmpDirs: string[] = [];

const PLAN = {
  title: "API plan",
  goal: "cover routes",
  tasks: [
    {
      id: "T1",
      title: "task",
      blocks: [
        { id: "B1", title: "b1", instructions: "i1", acceptance: "a1", deps: [], maxReviewCycles: 2 },
        { id: "B2", title: "b2", instructions: "i2", acceptance: "a2", deps: ["T1:B1"], maxReviewCycles: 2 }
      ]
    }
  ]
};

beforeEach(async () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);

  workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "eva-plan-weave-api-"));
  tmpDirs.push(workspaceRoot);

  const repo = new DrizzleWorkspaceRepository(db);
  repo.create({ id: "w1", name: "repo", path: workspaceRoot });

  app = Fastify();
  app.decorate("services", {
    planWeave: new PlanWeaveService(new WorkspaceStore(repo))
  } as never);
  registerPlanWeaveRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeDb(db);
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const createPlan = () =>
  app.inject({ method: "POST", url: "/api/v1/workspaces/w1/plan", payload: { plan: PLAN } });

describe("plan-weave REST(11 条)", () => {
  it("workspace 不存在 → 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/workspaces/nope/plan" });
    expect(res.statusCode).toBe(404);
  });

  it("无 plan 时 GET → 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/workspaces/w1/plan" });
    expect(res.statusCode).toBe(404);
  });

  it("happy path:create → get → block → claim → submit → review → blocked → reset → archive → delete", async () => {
    // POST /plan(201)
    const created = await createPlan();
    expect(created.statusCode).toBe(201);
    expect((created.json() as { progress: { total: number } }).progress.total).toBe(2);

    // POST /plan 已存在 → 409
    const dup = await createPlan();
    expect(dup.statusCode).toBe(409);

    // GET /plan
    const got = await app.inject({ method: "GET", url: "/api/v1/workspaces/w1/plan" });
    expect(got.statusCode).toBe(200);
    const snap = got.json() as { tasks: Array<{ blocks: Array<{ ref: string; status: string }> }> };
    expect(snap.tasks[0]?.blocks.map((b) => b.status)).toEqual(["ready", "pending"]);

    // GET /plan/block?ref=
    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces/w1/plan/block?ref=T1:B1"
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { ref: string }).ref).toBe("T1:B1");

    const missingBlock = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces/w1/plan/block?ref=T9:B9"
    });
    expect(missingBlock.statusCode).toBe(404);

    // POST /plan/claim
    const claimed = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/w1/plan/claim",
      payload: { runId: "r1" }
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({ kind: "block", ref: "T1:B1", alreadyClaimed: false });

    // POST /plan/submit
    const submitted = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/w1/plan/submit",
      payload: { ref: "T1:B1", report: "done" }
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({ ref: "T1:B1", runs: 1 });

    // POST /plan/review
    const reviewed = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/w1/plan/review",
      payload: { ref: "T1:B1", verdict: "approved" }
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json()).toMatchObject({ ref: "T1:B1", status: "done" });

    const needsNotes = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/w1/plan/review",
      payload: { ref: "T1:B1", verdict: "needs_changes" }
    });
    expect(needsNotes.statusCode).toBe(400);

    // POST /plan/blocked(done 不可 block → 400;正常 block B2 → 200)
    const blockDone = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/w1/plan/blocked",
      payload: { ref: "T1:B1", blocked: true, reason: "x" }
    });
    expect(blockDone.statusCode).toBe(400);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/w1/plan/blocked",
      payload: { ref: "T1:B2", blocked: true, reason: "等外部依赖" }
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({ ref: "T1:B2", status: "blocked" });

    // POST /plan/reset
    const reset = await app.inject({ method: "POST", url: "/api/v1/workspaces/w1/plan/reset" });
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as { progress: { done: number } }).progress.done).toBe(0);

    // POST /plan/archive
    const archived = await app.inject({ method: "POST", url: "/api/v1/workspaces/w1/plan/archive" });
    expect(archived.statusCode).toBe(200);
    expect((archived.json() as { archivePath: string }).archivePath).toContain("plan-weave-archive");

    const afterArchive = await app.inject({ method: "GET", url: "/api/v1/workspaces/w1/plan" });
    expect(afterArchive.statusCode).toBe(404);

    // archive 后可重新 create
    expect((await createPlan()).statusCode).toBe(201);

    // DELETE /plan
    const deleted = await app.inject({ method: "DELETE", url: "/api/v1/workspaces/w1/plan" });
    expect(deleted.statusCode).toBe(204);
    const afterDelete = await app.inject({ method: "GET", url: "/api/v1/workspaces/w1/plan" });
    expect(afterDelete.statusCode).toBe(404);
  });

  it("open feedback:claim 先给 feedback,resolve 后才轮到 block", async () => {
    expect((await createPlan()).statusCode).toBe(201);

    // 手改 state.json 塞 open feedback
    const statePath = path.join(planWeaveDir(workspaceRoot), "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { feedback: unknown[] };
    state.feedback.push({
      id: "FB-1",
      blockId: "T1:B1",
      content: "补边界条件",
      status: "open",
      createdAt: new Date().toISOString()
    });
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

    const claimed = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/w1/plan/claim",
      payload: { runId: "r1" }
    });
    expect(claimed.json()).toMatchObject({ kind: "feedback", feedbackId: "FB-1" });

    const resolved = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/w1/plan/resolve",
      payload: { feedbackId: "FB-1", resolution: "已补" }
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ feedbackId: "FB-1", status: "resolved" });

    const next = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/w1/plan/claim",
      payload: { runId: "r1" }
    });
    expect(next.json()).toMatchObject({ kind: "block", ref: "T1:B1" });
  });
});
