import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { planWeaveArchiveDir, planWeaveDir } from "../../paths.js";
import {
  planFileSchema,
  stateFileSchema,
  PlanWeaveError,
  type PlanFile,
  type StateFile
} from "./schema.js";

/**
 * 原子写:tmp → fsync → rename。保证任何时刻读到的都是完整 JSON,
 * 但**不防**跨 await 的 read-modify-write lost update —— 那是 withLock 的事。
 */
const atomicWrite = async (filePath: string, content: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, filePath);
};

const readJson = async (filePath: string): Promise<unknown | undefined> => {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // 契约 9:文件被人改坏 → 明确错误文案,聊天不卡死。
    throw new PlanWeaveError(
      "invalid",
      `Plan Weave 文件已损坏:${filePath}(不是合法 JSON)。请手工修复或删除后重试。`
    );
  }
};

/**
 * T46 §2.3:plan.json / state.json / results 的文件存取。
 *
 * 两道防线各管一件事:
 * - 原子写(atomicWrite):读不到半个文件;
 * - per-workspace in-process mutex(withLock):同 workspace 两个 run 并发
 *   submit 的 read-modify-write 不互相覆盖。Fastify 单进程,
 *   Map<workspaceId, Promise> 串行化就够。每个 mutation 都是
 *   「进锁 → 读 → 改 → 原子写 → 出锁」,锁内不做 LLM 调用、不做长 IO。
 */
export class PlanFileStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  /** 同一 workspaceId 的 mutation 串行;读(get/status)在锁外 —— 原子写保证单文件一致。 */
  withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(workspaceId) ?? Promise.resolve();
    // 链上只存永不 reject 的 settled,所以 prev 一定正常兑现,直接 then 即可。
    const next = prev.then(fn);
    // 链上只挂「完成信号」(吞掉值与错误),后续等待者不被前一次的 reject 波及。
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(workspaceId, settled);
    // 队尾就是自己时清掉,别让 chains 随 workspace 数单调涨。
    void settled.then(() => {
      if (this.chains.get(workspaceId) === settled) {
        this.chains.delete(workspaceId);
      }
    });
    return next;
  }

  exists(root: string): boolean {
    return existsSync(path.join(planWeaveDir(root), "plan.json"));
  }

  async readPlan(root: string): Promise<PlanFile | undefined> {
    const filePath = path.join(planWeaveDir(root), "plan.json");
    const raw = await readJson(filePath);
    if (raw === undefined) return undefined;
    const parsed = planFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PlanWeaveError(
        "invalid",
        `Plan Weave 的 plan.json 已损坏:${parsed.error.issues[0]?.message ?? "schema 校验失败"}。请手工修复或 archive 后重建。`
      );
    }
    return parsed.data;
  }

  async readState(root: string): Promise<StateFile> {
    const filePath = path.join(planWeaveDir(root), "state.json");
    const raw = await readJson(filePath);
    if (raw === undefined) {
      // state.json 缺失(plan.json 在人手整理时单独留下)→ 当初始态自愈。
      return {
        blocks: {},
        current: null,
        feedback: [],
        updatedAt: new Date().toISOString()
      };
    }
    const parsed = stateFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PlanWeaveError(
        "invalid",
        `Plan Weave 的 state.json 已损坏:${parsed.error.issues[0]?.message ?? "schema 校验失败"}。请手工修复或 reset。`
      );
    }
    return parsed.data;
  }

  async writePlan(root: string, plan: PlanFile): Promise<void> {
    await atomicWrite(
      path.join(planWeaveDir(root), "plan.json"),
      JSON.stringify(plan, null, 2) + "\n"
    );
  }

  async writeState(root: string, state: StateFile): Promise<void> {
    await atomicWrite(
      path.join(planWeaveDir(root), "state.json"),
      JSON.stringify(state, null, 2) + "\n"
    );
  }

  /** results/<taskId>/<fileName> 的原子写。taskId/fileName 都过了 id regex,无路径逃逸。 */
  async writeResult(
    root: string,
    taskId: string,
    fileName: string,
    content: string
  ): Promise<void> {
    await atomicWrite(
      path.join(planWeaveDir(root), "results", taskId, fileName),
      content
    );
  }

  async readResult(
    root: string,
    taskId: string,
    fileName: string
  ): Promise<string | undefined> {
    try {
      return await readFile(
        path.join(planWeaveDir(root), "results", taskId, fileName),
        "utf-8"
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listResults(root: string, taskId: string): Promise<string[]> {
    try {
      return await readdir(path.join(planWeaveDir(root), "results", taskId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** 整个 plan-weave 目录 move 到 archive;<ts>-<slug>,撞名时追加短随机后缀。 */
  async archive(root: string, slug: string): Promise<string> {
    const source = planWeaveDir(root);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveRoot = planWeaveArchiveDir(root);
    await mkdir(archiveRoot, { recursive: true });

    let dest = path.join(archiveRoot, `${stamp}-${slug}`);
    if (existsSync(dest)) {
      dest = `${dest}-${crypto.randomUUID().slice(0, 8)}`;
    }
    await rename(source, dest);
    return dest;
  }

  async removeAll(root: string): Promise<void> {
    await rm(planWeaveDir(root), { recursive: true, force: true });
  }
}
