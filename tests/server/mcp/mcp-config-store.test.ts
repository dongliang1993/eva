import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpConfigStore } from "../../../apps/server/src/modules/mcp/index.js";

let dir: string;
let filePath: string;
let store: McpConfigStore;

const writeConfig = (content: unknown): void => {
  writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
};

const readConfig = (): unknown => JSON.parse(readFileSync(filePath, "utf-8"));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "eva-mcp-store-"));
  filePath = path.join(dir, "mcp.json");
  store = new McpConfigStore(filePath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("McpConfigStore 读", () => {
  it("stdio 与 http 两种形状都能读出(含默认值)", () => {
    writeConfig({
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

    const all = store.listAll();
    expect(all).toHaveLength(2);

    const fs = store.findByName("filesystem")!;
    expect(fs.id).toBe("filesystem");
    expect(fs.transport).toBe("stdio");
    expect(fs.command).toBe("npx");
    expect(fs.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(fs.env).toEqual({ FOO: "bar" });
    expect(fs.enabled).toBe(true);
    // env 值随配置直通(文件即事实源,明文是它的既定形态)
    expect(fs.env.FOO).toBe("bar");

    const km = store.findByName("internal-km")!;
    expect(km.transport).toBe("http");
    expect(km.url).toBe("https://km.example.com/mcp");
    expect(km.headers).toEqual({ Authorization: "Bearer x" });
    expect(km.autoApproveTools).toEqual(["search"]);
  });

  it("文件不存在 → 空(不抛)", () => {
    expect(store.listAll()).toEqual([]);
    expect(store.findById("nope")).toBeUndefined();
  });

  it("坏 JSON / 结构不合法 → 抛 McpConfigError,不当成空", () => {
    writeConfig("{ this is not json");
    expect(() => store.listAll()).toThrow(/不是合法 JSON/);

    writeConfig({ mcpServers: { bad: { command: "" } } });
    expect(() => store.listAll()).toThrow(/结构不合法/);
  });

  it("enabled:false 的条目不进 listEnabled", () => {
    writeConfig({
      mcpServers: { off: { command: "x", enabled: false }, on: { command: "y" } }
    });

    expect(store.listEnabled().map((s) => s.id)).toEqual(["on"]);
  });
});

describe("McpConfigStore 写", () => {
  it("create 写进文件;文件不存在时自动创建", () => {
    const created = store.create({
      name: "figma",
      transport: "stdio",
      command: "npx",
      args: ["-y", "figma-developer-mcp"],
      env: { FIGMA_API_KEY: "secret" }
    });

    expect(created.env).toEqual({ FIGMA_API_KEY: "secret" });

    const file = readConfig() as { mcpServers: Record<string, unknown> };
    expect(file.mcpServers.figma).toBeDefined();
    expect(store.listAll().map((s) => s.id)).toEqual(["figma"]);
  });

  it("update 全量替换;换 name = 删旧条目建新条目(名字即身份)", () => {
    store.create({ name: "old", transport: "stdio", command: "npx" });

    const updated = store.update("old", {
      name: "new",
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer t" }
    });

    expect(updated?.id).toBe("new");
    expect(store.findById("old")).toBeUndefined();
    expect(store.findById("new")?.url).toBe("https://example.com/mcp");
    // 旧条目没有从文件里留下残影
    expect((readConfig() as { mcpServers: Record<string, unknown> }).mcpServers.old).toBeUndefined();
  });

  it("update 不存在的 id → undefined,文件不动", () => {
    expect(store.update("nope", { name: "x", transport: "stdio", command: "c" })).toBeUndefined();
    expect(store.listAll()).toEqual([]);
  });

  it("setEnabled 改开关且保留其余字段", () => {
    store.create({
      name: "km",
      transport: "http",
      url: "https://km.example.com/mcp",
      autoApproveTools: ["search"]
    });

    const toggled = store.setEnabled("km", false);

    expect(toggled?.enabled).toBe(false);
    expect(store.findById("km")?.autoApproveTools).toEqual(["search"]);
  });

  it("deleteById 从文件移除条目", () => {
    store.create({ name: "a", transport: "stdio", command: "x" });
    store.create({ name: "b", transport: "stdio", command: "y" });

    expect(store.deleteById("a")).toBe(true);
    expect(store.listAll().map((s) => s.id)).toEqual(["b"]);
    expect(store.deleteById("a")).toBe(false);
  });

  it("写回保留文件里手工加的注释性字段不丢其余条目", () => {
    writeConfig({
      mcpServers: {
        keep: { command: "keep-cmd" },
        gone: { command: "gone-cmd" }
      }
    });

    store.deleteById("gone");

    const file = readConfig() as { mcpServers: Record<string, { command: string }> };
    expect(file.mcpServers.keep.command).toBe("keep-cmd");
    expect(file.mcpServers.gone).toBeUndefined();
  });
});
