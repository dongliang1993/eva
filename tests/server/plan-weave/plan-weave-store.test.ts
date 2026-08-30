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
import { DrizzleWorkspaceRepository, WorkspaceStore } from "../../../apps/server/src/modules/workspaces/index.js";
import { planWeaveDir } from "../../../apps/server/src/paths.js";
import { PlanWeaveService, type PlanSnapshot } from "../../../apps/server/src/modules/plan-weave/index.js";

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

  const root = await mkdtemp(path.join(os.tmpdir(), "eva-plan-weave-"));
  tempDirs.push(root);

  const repo = new DrizzleWorkspaceRepository(db);
  repo.create({ id: "w1", name: "repo", path: root });

  const service = new PlanWeaveService(new WorkspaceStore(repo));
  return { root, service };
};

const block = (
  id: string,
  deps: string[] = [],
  maxReviewCycles = 2
): {
  id: string;
  title: string;
  instructions: string;
  acceptance: string;
  deps: string[];
  maxReviewCycles: number;
} => ({
  id,
  title: `Block ${id}`,
  instructions: `do ${id}`,
  acceptance: `${id} done`,
  deps,
  maxReviewCycles
});

const chainPlan = () => ({
  title: "Ship feature",
  goal: "Get it done",
  tasks: [
    {
      id: "T1",
      title: "Task 1",
      blocks: [block("B1"), block("B2", ["T1:B1"])]
    },
    {
      id: "T2",
      title: "Task 2",
      blocks: [block("B1", ["T1:B2"], 1)]
    }
  ]
});

const statusOf = (snap: PlanSnapshot, ref: string): string => {
  for (const task of snap.tasks) {
    for (const b of task.blocks) {
      if (b.ref === ref) return b.status;
    }
  }
  throw new Error(`block ${ref} not in snapshot`);
};

describe("plan-weave store: ready 重算与校验", () => {
  it("deps 未完 → pending;deps 全 done → ready", async () => {
    const { service } = await setup();
    await service.create("w1", chainPlan());

    let snap = await service.get("w1");
    expect(statusOf(snap, "T1:B1")).toBe("ready");
    expect(statusOf(snap, "T1:B2")).toBe("pending");
    expect(statusOf(snap, "T2:B1")).toBe("pending");

    await service.claim("w1", "run-a");
    await service.submit("w1", "T1:B1", "report 1");
    await service.review("w1", "T1:B1", "approved");

    snap = await service.get("w1");
    expect(statusOf(snap, "T1:B1")).toBe("done");
    expect(statusOf(snap, "T1:B2")).toBe("ready");
    expect(statusOf(snap, "T2:B1")).toBe("pending");
  });

  it("环形 deps → create 报错且不落盘", async () => {
    const { root, service } = await setup();
    const cyclic = {
      title: "cyclic",
      goal: "g",
      tasks: [
        {
          id: "T1",
          title: "t",
          blocks: [block("B1", ["T1:B2"]), block("B2", ["T1:B1"])]
        }
      ]
    };

    await expect(service.create("w1", cyclic)).rejects.toThrow(/循环/);
    await expect(readFile(path.join(planWeaveDir(root), "plan.json"), "utf-8")).rejects.toThrow();
  });

  it("deps 引用不存在的 ref → 报错", async () => {
    const { service } = await setup();
    const dangling = {
      title: "dangling",
      goal: "g",
      tasks: [
        { id: "T1", title: "t", blocks: [block("B1", ["T9:B9"])] }
      ]
    };

    await expect(service.create("w1", dangling)).rejects.toThrow(/不存在/);
  });

  it("空 blocks / maxReviewCycles=0 → 报错", async () => {
    const { service } = await setup();

    await expect(
      service.create("w1", { title: "t", goal: "g", tasks: [{ id: "T1", title: "t", blocks: [] }] })
    ).rejects.toThrow();

    await expect(
      service.create("w1", {
        title: "t",
        goal: "g",
        tasks: [{ id: "T1", title: "t", blocks: [block("B1", [], 0)] }]
      })
    ).rejects.toThrow();
  });

  it("手改 plan.json 后重算能自愈(去掉 dep → ready)", async () => {
    const { root, service } = await setup();
    await service.create("w1", chainPlan());

    const planPath = path.join(planWeaveDir(root), "plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf-8")) as {
      tasks: Array<{ id: string; blocks: Array<{ id: string; deps: string[] }> }>;
    };
    plan.tasks[0]!.blocks[1]!.deps = [];
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf-8");

    const snap = await service.get("w1");
    expect(statusOf(snap, "T1:B2")).toBe("ready");
    expect(statusOf(snap, "T1:B1")).toBe("ready");
  });

  it("已有 plan 时 create 报错(提示 archive/reset),旧 plan 不被覆盖", async () => {
    const { root, service } = await setup();
    await service.create("w1", chainPlan());

    await expect(service.create("w1", chainPlan())).rejects.toThrow(/archive|reset/);

    const onDisk = JSON.parse(
      await readFile(path.join(planWeaveDir(root), "plan.json"), "utf-8")
    ) as { title: string };
    expect(onDisk.title).toBe("Ship feature");
  });

  it("并发 submit 不丢更新(mutex),state.json 始终可解析", async () => {
    const { root, service } = await setup();
    const width = 8;
    await service.create("w1", {
      title: "parallel",
      goal: "g",
      tasks: [
        {
          id: "T1",
          title: "t",
          blocks: Array.from({ length: width }, (_, i) => block(`B${i + 1}`))
        }
      ]
    });

    // 先把 8 个 block 全部推进到 in_progress(runs=1):claim 一个交一个,current 随之易手。
    for (let i = 1; i <= width; i += 1) {
      const claimed = await service.claim("w1", "run-a");
      if (claimed.kind !== "block") throw new Error(`expected block claim, got ${claimed.kind}`);
      await service.submit("w1", claimed.ref, `first pass ${claimed.ref}`);
    }

    // 并发第二轮 submit:没有 per-workspace mutex 时 read-modify-write 会互相覆盖。
    await Promise.all(
      Array.from({ length: width }, (_, i) =>
        service.submit("w1", `T1:B${i + 1}`, `second pass ${i + 1}`)
      )
    );

    const statePath = path.join(planWeaveDir(root), "state.json");
    const state = JSON.parse(await readFile(statePath, "utf-8")) as {
      blocks: Record<string, { runs: number; status: string }>;
    };
    for (let i = 1; i <= width; i += 1) {
      expect(state.blocks[`T1:B${i}`]?.runs).toBe(2);
    }

    const snap = await service.get("w1");
    expect(snap.progress).toEqual({ done: 0, total: width });
  });

  it("plan.json 被人为改坏 → 明确错误文案(契约 9),不卡死", async () => {
    const { root, service } = await setup();
    await service.create("w1", chainPlan());

    await writeFile(path.join(planWeaveDir(root), "plan.json"), "{ not json", "utf-8");
    await expect(service.get("w1")).rejects.toThrow(/损坏/);
    await expect(service.claim("w1", "run-a")).rejects.toThrow(/损坏/);
  });
});
