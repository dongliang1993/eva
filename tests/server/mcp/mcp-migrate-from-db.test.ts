import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeDb,
  initDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import { McpConfigStore } from "../../../apps/server/src/modules/mcp/index.js";
import { migrateMcpServersToFile } from "../../../apps/server/src/modules/mcp/index.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

let db: AppDatabase;
let dir: string;
let store: McpConfigStore;

beforeEach(() => {
  // 不跑 migrateDb —— 迁移对象是「还没被 0031 删掉的」旧表,手工建
  db = initDb({ dbPath: ":memory:" });
  dir = mkdtempSync(path.join(tmpdir(), "eva-mcp-migrate-"));
  store = new McpConfigStore(path.join(dir, "mcp.json"));
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

/** 手工建一张旧版 mcp_servers 表(0030 之前/之时的形状)并塞条目。 */
const seedLegacyTable = (
  rows: ReadonlyArray<Record<string, unknown>>
): void => {
  // drizzle 的 run() 只吃 sql 模板,裸 SQL + 绑定参数走底层 $client
  const sqlite = (
    db as unknown as { $client: { exec: (sql: string) => void; prepare: (sql: string) => { run: (...params: unknown[]) => unknown } } }
  ).$client;

  sqlite.exec(`
    CREATE TABLE mcp_servers (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      origin text NOT NULL DEFAULT 'manual',
      transport text NOT NULL,
      command text,
      args text NOT NULL DEFAULT '[]',
      env text NOT NULL DEFAULT '{}',
      url text,
      headers text NOT NULL DEFAULT '{}',
      auto_approve_tools text NOT NULL DEFAULT '[]',
      enabled integer NOT NULL DEFAULT 1,
      created_at text NOT NULL DEFAULT (datetime('now')),
      updated_at text NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const insert = sqlite.prepare(
    `INSERT INTO mcp_servers (id, name, transport, command, args, env, url, headers, auto_approve_tools, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const row of rows) {
    insert.run(
      row.id, row.name, row.transport, row.command ?? null, row.args ?? "[]",
      row.env ?? "{}", row.url ?? null, row.headers ?? "{}",
      row.auto_approve_tools ?? "[]", row.enabled ?? 1
    );
  }
};

describe("migrateMcpServersToFile", () => {
  it("表里的条目(含 env 密钥值)搬进 mcp.json", () => {
    seedLegacyTable([
      {
        id: "uuid-1",
        name: "figma",
        transport: "stdio",
        command: "npx",
        args: JSON.stringify(["-y", "figma-developer-mcp"]),
        env: JSON.stringify({ FIGMA_API_KEY: "figd_secret" })
      },
      {
        id: "uuid-2",
        name: "km",
        transport: "http",
        url: "https://km.example.com/mcp",
        headers: JSON.stringify({ Authorization: "Bearer t" }),
        enabled: 0
      }
    ]);

    // 注入测试 store:默认路径是 ~/.eva/mcp.json,测试绝不碰用户真实文件
    migrateMcpServersToFile(db, logger(), store);

    expect(store.listAll().map((s) => s.id)).toEqual(["figma", "km"]);

    const figma = store.findById("figma")!;
    expect(figma.transport).toBe("stdio");
    expect(figma.command).toBe("npx");
    expect(figma.args).toEqual(["-y", "figma-developer-mcp"]);
    expect(figma.env).toEqual({ FIGMA_API_KEY: "figd_secret" });
    expect(figma.enabled).toBe(true);

    const km = store.findById("km")!;
    expect(km.transport).toBe("http");
    expect(km.url).toBe("https://km.example.com/mcp");
    expect(km.headers).toEqual({ Authorization: "Bearer t" });
    expect(km.enabled).toBe(false);
  });

  it("表不存在(0031 已跑过)→ 空转,不写文件", () => {
    const log = logger();
    migrateMcpServersToFile(db, log, store);

    expect(existsSync(path.join(dir, "mcp.json"))).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("文件里已存在的条目名不被表覆盖(文件是新事实源)", () => {
    store.create({ name: "figma", transport: "stdio", command: "file-cmd" });
    seedLegacyTable([
      { id: "uuid-1", name: "figma", transport: "stdio", command: "db-cmd" }
    ]);

    const log = logger();
    migrateMcpServersToFile(db, log, store);

    expect(store.findById("figma")!.command).toBe("file-cmd");
    expect(log.warn).toHaveBeenCalled();
  });
});
