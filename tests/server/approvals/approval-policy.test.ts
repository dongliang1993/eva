import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, initDb, migrateDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import { ApprovalRepository } from "../../../apps/server/src/db/repositories/approval-repository.js";
import { ApprovalGateway } from "../../../apps/server/src/services/approval-gateway.js";
import { ApprovalPolicyStore } from "../../../apps/server/src/services/approval-policy-store.js";
import {
  loadAppSettings,
  replaceAppSettings
} from "../../../apps/server/src/services/settings/app-settings.js";

const config = { LOG_LEVEL: "info", PORT: 8082, HOST: "127.0.0.1", DB_PATH: "" } as never;

/**
 * T28:policy 记忆短路(docs/plans/r7/T28)。
 * 放行链序:T14 白名单 → policy 短路 → ask(弹卡片)。短路命中 = 不发 approval_request、
 * 不进 pending Map、台账照记 granted + reason=policy:<key>。
 */
/** 放行链的源码 —— 两条「钉接线」的测试共用,读一次就够。 */
const approvalChannelSource = readFileSync(
  new URL("../../../apps/server/src/services/runs/run-approval-channel.ts", import.meta.url),
  "utf8"
);

describe("T28 policy 短路", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it("命中即直放:autoApprove 落 granted + reason,ask 未被调", () => {
    // settings 里已有一条「s-1 里 npm test 始终允许」的记忆。
    const current = loadAppSettings(db, config);
    replaceAppSettings(db, config, {
      ...current,
      security: {
        ...current.security,
        allowAlwaysPolicies: ["bash:thread:s-1:command:npm test"]
      }
    });

    const store = new ApprovalPolicyStore(db, config);
    const repo = new ApprovalRepository(db);
    const gateway = new ApprovalGateway(repo);
    const askSpy = vi.spyOn(gateway, "ask");

    // 模拟 runs.ts requestApproval 的调用序:先 match,命中 → autoApprove,绝不进 ask。
    const hit = store.match("bash", "s-1", { command: "npm test" });
    expect(hit).toBe("bash:thread:s-1:command:npm test");

    if (hit) {
      gateway.autoApprove(
        "call-1",
        { runId: "run-1", sessionId: "s-1", tool: "bash", args: { command: "npm test" } },
        `policy:${hit}`
      );
    }

    expect(askSpy).not.toHaveBeenCalled();
    expect(gateway.listPending("s-1")).toHaveLength(0);
    const row = repo.getById("call-1");
    expect(row?.status).toBe("granted");
    expect(row?.reason).toBe("policy:bash:thread:s-1:command:npm test");
  });

  it("换 thread 不命中:policy 不跨会话泄漏", () => {
    const current = loadAppSettings(db, config);
    replaceAppSettings(db, config, {
      ...current,
      security: {
        ...current.security,
        allowAlwaysPolicies: ["bash:thread:s-1:command:npm test"]
      }
    });

    const store = new ApprovalPolicyStore(db, config);
    expect(store.match("bash", "s-2", { command: "npm test" })).toBeNull();
  });

  it("未命中走 pending:ask 正常落库待决", async () => {
    const store = new ApprovalPolicyStore(db, config);
    const gateway = new ApprovalGateway(new ApprovalRepository(db));

    expect(store.match("bash", "s-1", { command: "npm test" })).toBeNull();

    const asked = gateway.ask("c1", {
      runId: "run-1",
      sessionId: "s-1",
      tool: "bash",
      args: { command: "npm test" }
    });
    expect(gateway.listPending("s-1")).toHaveLength(1);
    expect(new ApprovalRepository(db).getById("c1")?.status).toBe("pending");

    gateway.cancelByRun("run-1");
    await expect(asked).resolves.toBe(false);
  });

  it("bash 的 :all 粗 key 也命中(精确 key 优先返回)", () => {
    const current = loadAppSettings(db, config);
    replaceAppSettings(db, config, {
      ...current,
      security: {
        ...current.security,
        allowAlwaysPolicies: ["bash:thread:s-1:all"]
      }
    });

    const store = new ApprovalPolicyStore(db, config);
    expect(store.match("bash", "s-1", { command: "pnpm build" })).toBe("bash:thread:s-1:all");
  });

  it("policy 短路在 emit approval_request 之前(钉接线,防回归)", () => {
    // 短路放进 ask() 内部会让「没问过人」的卡片在前端闪一帧(T28 §1.2)。
    // 这里直接钉源码形态:match 必须出现在 approval_request 帧之前。
    //
    // Wave 1 起放行链搬到 run-approval-channel.ts(原先在 routes/runs.ts)。
    const matchAt = approvalChannelSource.indexOf("approvalPolicies.match(");
    const emitAt = approvalChannelSource.indexOf('type: "approval_request"');
    expect(matchAt).toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(-1);
    expect(matchAt).toBeLessThan(emitAt);
  });

  it("四级放行链的顺序是 bash只读 → plan文件 → policy → 弹窗(§7.2)", () => {
    // 这四级的**顺序本身**是产品行为,不是实现细节。举一个具体的错法:把 policy
    // 提到 plan 文件之前,用户点过一次「始终允许 write」之后,plan 文件写会记在
    // write:thread:<id>:all 这个 key 上 —— 该会话此后所有写全免弹窗,而不只是 plan 文件。
    //
    // Wave 1 把四级收进同一个文件,顺序第一次变得可以一眼验证 —— 于是把它钉下来。
    const at = (needle: string): number => {
      const index = approvalChannelSource.indexOf(needle);
      expect(index, `找不到放行链的这一级: ${needle}`).toBeGreaterThan(-1);
      return index;
    };

    const readonlyBash = at("isSafeReadOnlyCommand(");
    const planFile = at("matchesPlanGatePath(");
    const policy = at("approvalPolicies.match(");
    const ask = at("approvals.ask(");

    expect(readonlyBash).toBeLessThan(planFile);
    expect(planFile).toBeLessThan(policy);
    expect(policy).toBeLessThan(ask);
  });
});

describe("T28 reason 列", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it("decide 带 reason 落列;不带保持 NULL", () => {
    const repo = new ApprovalRepository(db);
    repo.create({ id: "c1", sessionId: "s1", runId: "run-1", tool: "bash", args: {} });
    repo.create({ id: "c2", sessionId: "s1", runId: "run-1", tool: "bash", args: {} });

    repo.decide("c1", "granted", "policy:bash:thread:s1:all");
    repo.decide("c2", "granted");

    expect(repo.getById("c1")?.reason).toBe("policy:bash:thread:s1:all");
    expect(repo.getById("c2")?.reason).toBeNull();
  });

  it("failStalePending 收的行 reason=stale-restart,已决策行的 reason 不被覆盖", () => {
    const repo = new ApprovalRepository(db);
    repo.create({ id: "c1", sessionId: "s1", runId: "run-1", tool: "bash", args: {} });
    repo.create({ id: "c2", sessionId: "s1", runId: "run-1", tool: "bash", args: {} });
    repo.decide("c2", "granted", "policy:x");

    expect(repo.failStalePending()).toBe(1);

    expect(repo.getById("c1")?.status).toBe("denied");
    expect(repo.getById("c1")?.reason).toBe("stale-restart");
    expect(repo.getById("c2")?.reason).toBe("policy:x");
  });

  it("autoApprove 的 reason 透传:子代理路径不传保持 NULL", () => {
    const repo = new ApprovalRepository(db);
    const gateway = new ApprovalGateway(repo);

    gateway.autoApprove("p1", { runId: "r", sessionId: "s", tool: "bash", args: {} }, "policy:k");
    gateway.autoApprove("p2", { runId: "r", sessionId: "s", tool: "bash", args: {} });

    expect(repo.getById("p1")?.reason).toBe("policy:k");
    expect(repo.getById("p2")?.reason).toBeNull();
  });
});

describe("T28 grant 写回", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it("grant 后读回含该 key,且 models/chat/memory 三块原样还在", () => {
    const before = loadAppSettings(db, config);
    replaceAppSettings(db, config, {
      ...before,
      models: { tool: "openai:gpt-4o-mini" },
      chat: { ...before.chat, temperature: 0.7 },
      memory: { ...before.memory, maxRetrievedMemories: 9 }
    });

    const store = new ApprovalPolicyStore(db, config);
    store.grant("bash:thread:s-1:all");

    const after = loadAppSettings(db, config);
    expect(after.security.allowAlwaysPolicies).toContain("bash:thread:s-1:all");
    expect(after.models.tool).toBe("openai:gpt-4o-mini");
    expect(after.chat.temperature).toBe(0.7);
    expect(after.memory.maxRetrievedMemories).toBe(9);

    // 内存缓存同步刷新:grant 后立刻可查。
    expect(store.match("bash", "s-1", { command: "anything" })).toBe("bash:thread:s-1:all");
  });

  it("重复 grant 同一 key 幂等", () => {
    const store = new ApprovalPolicyStore(db, config);
    store.grant("bash:thread:s-1:all");
    store.grant("bash:thread:s-1:all");

    const after = loadAppSettings(db, config);
    expect(
      after.security.allowAlwaysPolicies.filter((k) => k === "bash:thread:s-1:all")
    ).toHaveLength(1);
  });
});
