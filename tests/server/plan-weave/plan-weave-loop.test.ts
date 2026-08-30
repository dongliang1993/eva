import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import { DrizzleWorkspaceRepository } from "../../../apps/server/src/db/repositories/workspace-repository.js";
import { planWeaveDir } from "../../../apps/server/src/paths.js";
import { PlanWeaveService } from "../../../apps/server/src/services/plan-weave/index.js";
import { WorkspaceStore } from "../../../apps/server/src/services/workspaces/workspace-store.js";

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

  const root = await mkdtemp(path.join(os.tmpdir(), "eva-plan-weave-loop-"));
  tempDirs.push(root);

  const repo = new DrizzleWorkspaceRepository(db);
  repo.create({ id: "w1", name: "repo", path: root });

  const service = new PlanWeaveService(new WorkspaceStore(repo));
  return { root, service };
};

const twoBlockPlan = (maxReviewCycles = 2) => ({
  title: "Loop plan",
  goal: "run the loop",
  tasks: [
    {
      id: "T1",
      title: "Only task",
      blocks: [
        {
          id: "B1",
          title: "First",
          instructions: "write the thing",
          acceptance: "thing written",
          deps: [],
          maxReviewCycles
        },
        {
          id: "B2",
          title: "Second",
          instructions: "ship the thing",
          acceptance: "thing shipped",
          deps: ["T1:B1"],
          maxReviewCycles
        }
      ]
    }
  ]
});

describe("plan-weave 闭环: claim → submit → review → resolve", () => {
  it("完整闭环推进到下一个 ready block", async () => {
    const { root, service } = await setup();
    await service.create("w1", twoBlockPlan());

    const first = await service.claim("w1", "run-a");
    if (first.kind !== "block") throw new Error(`expected block, got ${first.kind}`);
    expect(first.ref).toBe("T1:B1");
    expect(first.alreadyClaimed).toBe(false);
    expect(first.packet).toContain("run the loop");
    expect(first.packet).toContain("write the thing");
    expect(first.packet).toContain("thing written");
    expect(first.packet).toContain("plan_submit");

    const submitted = await service.submit("w1", "T1:B1", "done the thing");
    expect(submitted.runs).toBe(1);
    const runReport = await readFile(
      path.join(planWeaveDir(root), "results", "T1", "B1.run-1.md"),
      "utf-8"
    );
    expect(runReport).toBe("done the thing");

    const reviewed = await service.review("w1", "T1:B1", "approved");
    expect(reviewed.status).toBe("done");

    const second = await service.claim("w1", "run-a");
    if (second.kind !== "block") throw new Error(`expected block, got ${second.kind}`);
    expect(second.ref).toBe("T1:B2");
    // 上游报告摘要进 packet
    expect(second.packet).toContain("done the thing");
  });

  it("重复 claim 同 runId → alreadyClaimed 且 packet 相同", async () => {
    const { service } = await setup();
    await service.create("w1", twoBlockPlan());

    const first = await service.claim("w1", "run-a");
    const again = await service.claim("w1", "run-a");

    if (first.kind !== "block" || again.kind !== "block") {
      throw new Error("expected block claims");
    }
    expect(again.alreadyClaimed).toBe(true);
    expect(again.ref).toBe(first.ref);
    expect(again.packet).toBe(first.packet);

    const snap = await service.get("w1");
    expect(snap.current).toMatchObject({ kind: "block", id: "T1:B1", owner: "run-a" });
  });

  it("别的 runId claim → busy + owner 可见", async () => {
    const { service } = await setup();
    await service.create("w1", twoBlockPlan());

    await service.claim("w1", "run-a");
    const busy = await service.claim("w1", "run-b");

    if (busy.kind !== "busy") throw new Error(`expected busy, got ${busy.kind}`);
    expect(busy.owner).toBe("run-a");
  });

  it("needs_changes 必须带 notes;block 回 ready,reviews + 1,review 文件落盘", async () => {
    const { root, service } = await setup();
    await service.create("w1", twoBlockPlan());

    await service.claim("w1", "run-a");
    await service.submit("w1", "T1:B1", "v1 report");

    await expect(service.review("w1", "T1:B1", "needs_changes")).rejects.toThrow(/notes/);

    const reviewed = await service.review("w1", "T1:B1", "needs_changes", "缺少错误处理");
    expect(reviewed.status).toBe("ready");
    expect(reviewed.reviews).toBe(1);

    const reviewFile = await readFile(
      path.join(planWeaveDir(root), "results", "T1", "B1.review-1.md"),
      "utf-8"
    );
    expect(reviewFile).toContain("缺少错误处理");

    const snap = await service.get("w1");
    expect(snap.current).toBeNull();

    // 回 ready 后能被再次 claim 到同一个 block
    const reclaimed = await service.claim("w1", "run-a");
    if (reclaimed.kind !== "block") throw new Error(`expected block, got ${reclaimed.kind}`);
    expect(reclaimed.ref).toBe("T1:B1");
  });

  it("reviews 达 maxReviewCycles → 自动关门放行并留痕", async () => {
    const { root, service } = await setup();
    await service.create("w1", twoBlockPlan(2));

    for (let round = 1; round <= 2; round += 1) {
      await service.claim("w1", "run-a");
      await service.submit("w1", "T1:B1", `report v${round}`);
      const reviewed = await service.review("w1", "T1:B1", "needs_changes", `round ${round} 还不行`);
      if (round === 1) {
        expect(reviewed.status).toBe("ready");
        expect(reviewed.forced).toBe(false);
      } else {
        expect(reviewed.status).toBe("done");
        expect(reviewed.forced).toBe(true);
      }
    }

    const reviewFile = await readFile(
      path.join(planWeaveDir(root), "results", "T1", "B1.review-2.md"),
      "utf-8"
    );
    expect(reviewFile).toContain("已达上限");

    const snap = await service.get("w1");
    expect(snap.progress).toEqual({ done: 1, total: 2 });
  });

  it("open feedback 优先;resolve 后才轮到 block", async () => {
    const { root, service } = await setup();
    await service.create("w1", twoBlockPlan());

    // 模拟人直接改 state.json 塞进一条 open feedback(文件即数据库)。
    const statePath = path.join(planWeaveDir(root), "state.json");
    const state = JSON.parse(await readFile(statePath, "utf-8")) as { feedback: unknown[] };
    state.feedback.push({
      id: "FB-1",
      blockId: "T1:B1",
      content: "B1 的产出漏了边界条件",
      status: "open",
      createdAt: new Date().toISOString()
    });
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");

    const claimed = await service.claim("w1", "run-a");
    if (claimed.kind !== "feedback") throw new Error(`expected feedback, got ${claimed.kind}`);
    expect(claimed.feedbackId).toBe("FB-1");
    expect(claimed.packet).toContain("B1 的产出漏了边界条件");
    expect(claimed.packet).toContain("plan_resolve");

    // 同 run 重发幂等
    const again = await service.claim("w1", "run-a");
    if (again.kind !== "feedback") throw new Error(`expected feedback, got ${again.kind}`);
    expect(again.alreadyClaimed).toBe(true);

    const resolved = await service.resolve("w1", "FB-1", "已补上边界条件处理");
    expect(resolved.status).toBe("resolved");

    const resolution = await readFile(
      path.join(planWeaveDir(root), "results", "T1", "FB-1.resolution.md"),
      "utf-8"
    );
    expect(resolution).toContain("已补上边界条件处理");

    const next = await service.claim("w1", "run-a");
    if (next.kind !== "block") throw new Error(`expected block, got ${next.kind}`);
    expect(next.ref).toBe("T1:B1");
  });

  it("reset 清空 current 与全部状态;archive 后可重新 create", async () => {
    const { root, service } = await setup();
    await service.create("w1", twoBlockPlan());
    await service.claim("w1", "run-a");

    const afterReset = await service.reset("w1");
    expect(afterReset.current).toBeNull();
    expect(afterReset.progress).toEqual({ done: 0, total: 2 });

    const { archivePath } = await service.archive("w1");
    expect(archivePath).toContain("plan-weave-archive");
    await expect(readFile(path.join(archivePath, "plan.json"), "utf-8")).resolves.toContain("Loop plan");
    await expect(readFile(path.join(planWeaveDir(root), "plan.json"), "utf-8")).rejects.toThrow();

    await service.create("w1", twoBlockPlan());
    const snap = await service.get("w1");
    expect(snap.progress.total).toBe(2);
  });
});
