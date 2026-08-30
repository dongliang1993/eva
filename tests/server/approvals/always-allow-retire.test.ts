import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPolicyKeys } from "../../../packages/harness/src/approval/policy-key.js";
import { closeDb, initDb, migrateDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import { ApprovalPolicyStore } from "../../../apps/server/src/modules/approvals/index.js";
import {
  loadAppSettings,
  replaceAppSettings
} from "../../../apps/server/src/modules/settings/index.js";

const config = { LOG_LEVEL: "info", PORT: 8082, HOST: "127.0.0.1", DB_PATH: "" } as never;

const readSource = (rel: string): string =>
  readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");

/**
 * T31:退役 alwaysAllowTools(docs/plans/r7/00-overview.md §3 契约 1 —— policy key 是单一事实来源)。
 * 旧白名单被 allowAlwaysPolicies 完全覆盖(语义 = thread:global:all),留着就是第二个事实源。
 */
describe("T31 grant 选 key(后端单一事实来源)", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  /** 模拟 grant 路由:buildPolicyKeys 选精确 key → grant。 */
  const grantViaRoute = (tool: string, sessionId: string, args: Record<string, unknown>): string | null => {
    const keys = buildPolicyKeys({ toolName: tool, threadId: sessionId, args });
    const store = new ApprovalPolicyStore(db, config);
    if (keys.length === 0) return null; // 不可记忆(destructive / 未知工具)
    const key = keys[0]!; // 精确 key 在前(T27 保证顺序)
    store.grant(key);
    return key;
  };

  it("bash 精确命令 → command key,同 thread 直放", () => {
    const key = grantViaRoute("bash", "s-1", { command: "npm test" });
    expect(key).toBe("bash:thread:s-1:command:npm test");

    const store = new ApprovalPolicyStore(db, config);
    expect(store.match("bash", "s-1", { command: "npm test" })).toBe(key);
    // 换命令不命中(精确 key 只管这一条)
    expect(store.match("bash", "s-1", { command: "rm x" })).toBeNull();
  });

  it("bash 空命令 → 落到 :all 粗 key", () => {
    const key = grantViaRoute("bash", "s-1", { command: "" });
    expect(key).toBe("bash:thread:s-1:all");
  });

  it("write/edit → tool:thread:all", () => {
    expect(grantViaRoute("write", "s-1", { path: "a.ts" })).toBe("write:thread:s-1:all");
    expect(grantViaRoute("edit", "s-1", { path: "a.ts" })).toBe("edit:thread:s-1:all");
  });

  it("destructive 不可记忆 → null,不写 settings", () => {
    expect(grantViaRoute("bash", "s-1", { command: "rm -rf /" })).toBeNull();
    const after = loadAppSettings(db, config);
    expect(after.security.allowAlwaysPolicies).toHaveLength(0);
  });
});

describe("T31 alwaysAllowTools 退役(钉死第二个事实源)", () => {
  it("runs.ts 放行链不再读 alwaysAllowTools", () => {
    const source = readSource("apps/server/src/modules/runs/route.ts");
    expect(source).not.toContain("alwaysAllowTools");
  });

  it("chat-page 的「始终允许」不再写 alwaysAllowTools(改走 grant 路由)", () => {
    const source = readSource("apps/web/src/features/threads/chat-page.tsx");
    expect(source).not.toContain("alwaysAllowTools");
    expect(source).not.toContain("enableAutoApprove");
  });

  it("security-settings 设置页渲染/删除的是 policies,不是 alwaysAllowTools", () => {
    const source = readSource("apps/web/src/features/settings/components/security-settings.tsx");
    expect(source).not.toContain("alwaysAllowTools");
    expect(source).toContain("allowAlwaysPolicies");
  });

  it("settings zod 不再要求 alwaysAllowTools 字段", () => {
    const source = readSource("apps/server/src/modules/settings/route.ts");
    expect(source).not.toContain("alwaysAllowTools");
  });

  it("shared AppSettings.security 不再有 alwaysAllowTools 字段", () => {
    const source = readSource("packages/shared/src/index.ts");
    expect(source).not.toContain("alwaysAllowTools");
  });
});

describe("T31 迁移收敛(幂等,迁完即净)", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  it("老库的 alwaysAllowTools 迁成 thread:global policies 后字段不再残留", async () => {
    // 模拟一座没迁过的老库:security 只有旧白名单,没有 policies。
    const legacy = loadAppSettings(db, config) as unknown as Record<string, unknown>;
    replaceAppSettings(db, config, {
      ...(legacy as never),
      security: { logLevel: "info", alwaysAllowTools: ["bash", "write"] } as never
    });

    const { migrateAlwaysAllowToolsToPolicies } = await import(
      "../../../apps/server/src/modules/settings/index.js"
    );
    const logger = { warn: () => undefined } as never;
    migrateAlwaysAllowToolsToPolicies(db, logger);

    const after = loadAppSettings(db, config);
    // 折成 thread:global 条目(T27 迁移规则)
    expect(after.security.allowAlwaysPolicies).toContain("bash:thread:global:all");
    expect(after.security.allowAlwaysPolicies).toContain("write:thread:global:all");
    // 退役后:settings 里不再有 alwaysAllowTools 这个键。
    expect("alwaysAllowTools" in after.security).toBe(false);
  });
});
