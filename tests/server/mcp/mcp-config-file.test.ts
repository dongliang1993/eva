import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import { McpServerRepository } from "../../../apps/server/src/modules/mcp/index.js";
import { syncMcpConfigFile } from "../../../apps/server/src/modules/mcp/index.js";

let db: AppDatabase;
let dir: string;
let repo: McpServerRepository;

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const writeConfig = (content: unknown): string => {
  const file = path.join(dir, "mcp.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  return file;
};

beforeEach(() => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
  repo = new McpServerRepository(db);
  dir = mkdtempSync(path.join(tmpdir(), "eva-mcp-"));
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("mcp.json 同步", () => {
  it("stdio 与 http 两种形状都能解析并落库", () => {
    const file = writeConfig({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { FOO: "bar" }
        },
        "internal-km": {
          url: "https://km.example.com/mcp",
          headers: { Authorization: "Bearer x" },
          autoApproveTools: ["search"]
        }
      }
    });

    const result = syncMcpConfigFile(db, logger(), file);

    expect(result.synced).toBe(2);

    const fs = repo.findByName("filesystem")!;
    expect(fs.origin).toBe("file");
    expect(fs.transport).toBe("stdio");
    expect(fs.command).toBe("npx");
    expect(fs.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(fs.env).toEqual({ FOO: "bar" });
    expect(fs.enabled).toBe(true);

    const km = repo.findByName("internal-km")!;
    expect(km.transport).toBe("http");
    expect(km.url).toBe("https://km.example.com/mcp");
    expect(km.headers).toEqual({ Authorization: "Bearer x" });
    expect(km.autoApproveTools).toEqual(["search"]);
  });

  it("名字不合法的条目跳过，其余照常同步", () => {
    const file = writeConfig({
      mcpServers: {
        "Bad Name": { command: "a" },
        UPPER: { command: "b" },
        good: { command: "c" }
      }
    });

    const log = logger();
    const result = syncMcpConfigFile(db, log, file);

    expect(result.synced).toBe(1);
    expect([...result.invalidNames].sort()).toEqual(["Bad Name", "UPPER"]);
    expect(repo.findByName("good")).toBeDefined();
    expect(repo.findByName("Bad Name")).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it("文件不存在 → 不抛、不写库、不报错日志", () => {
    const log = logger();
    const result = syncMcpConfigFile(db, log, path.join(dir, "nope.json"));

    expect(result.synced).toBe(0);
    expect(repo.listAll()).toHaveLength(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("坏 JSON → 不抛，记 error，不写库", () => {
    const file = writeConfig("{ this is not json");
    const log = logger();

    const result = syncMcpConfigFile(db, log, file);

    expect(result.synced).toBe(0);
    expect(repo.listAll()).toHaveLength(0);
    expect(log.error).toHaveBeenCalled();
  });

  it("文件里删掉一条 → 对应 file-origin 行消失，保留的行 id 不变", () => {
    const first = writeConfig({
      mcpServers: { a: { command: "a" }, b: { command: "b" } }
    });
    syncMcpConfigFile(db, logger(), first);
    const keptId = repo.findByName("a")!.id;

    const second = writeConfig({ mcpServers: { a: { command: "a2" } } });
    const result = syncMcpConfigFile(db, logger(), second);

    expect(result.removed).toBe(1);
    expect(repo.findByName("b")).toBeUndefined();
    // id 稳定:UI 与 registry 的状态都按 id 索引,换 id 会让状态跳一下
    expect(repo.findByName("a")!.id).toBe(keptId);
    expect(repo.findByName("a")!.command).toBe("a2");
  });

  it("manual 条目不受文件同步影响；撞名的文件条目被跳过", () => {
    repo.create("manual-1", "manual", { name: "shared", transport: "stdio", command: "manual-cmd" });

    const file = writeConfig({
      mcpServers: { shared: { command: "file-cmd" }, other: { command: "ok" } }
    });
    const log = logger();
    const result = syncMcpConfigFile(db, log, file);

    expect(result.skippedNames).toEqual(["shared"]);
    // manual 的配置没有被文件覆盖
    expect(repo.findByName("shared")!.command).toBe("manual-cmd");
    expect(repo.findByName("shared")!.origin).toBe("manual");
    expect(repo.findByName("other")!.origin).toBe("file");
    expect(log.warn).toHaveBeenCalled();
  });

  it("enabled: false 与 autoApproveTools 默认值", () => {
    const file = writeConfig({
      mcpServers: { off: { command: "x", enabled: false } }
    });
    syncMcpConfigFile(db, logger(), file);

    const row = repo.findByName("off")!;
    expect(row.enabled).toBe(false);
    expect(row.autoApproveTools).toEqual([]);
    expect(repo.listEnabled()).toHaveLength(0);
  });
});
