import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpConfigStore, McpServerClient } from "../../../apps/server/src/modules/mcp/index.js";
import {
  McpRegistry,
  type McpConnection,
  type McpServerFields
} from "../../../apps/server/src/modules/mcp/index.js";
import { startFakeMcpServer } from "../../helpers/fake-mcp-server.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

let dir: string;
let store: McpConfigStore;
let registry: McpRegistry;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "eva-mcp-registry-"));
  store = new McpConfigStore(path.join(dir, "mcp.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const addServer = (name: string, over: Partial<McpServerFields> = {}) =>
  store.create({
    name,
    transport: "stdio",
    command: "irrelevant-in-tests",
    ...(over.autoApproveTools !== undefined ? { autoApproveTools: over.autoApproveTools } : {}),
    ...(over.enabled !== undefined ? { enabled: over.enabled } : {})
  });

/** 假连接：只提供 registry 需要的 tools + callTool + close。 */
const fakeConnection = (
  toolNames: readonly string[],
  onClose?: () => void
): McpConnection => ({
  tools: toolNames.map((name) => ({
    name,
    description: `desc ${name}`,
    inputSchema: { type: "object", properties: {} },
    readOnly: name.startsWith("read")
  })),
  callTool: async () => "ok",
  close: async () => onClose?.()
});

describe("McpServerClient（跑真的 MCP 协议，用 InMemoryTransport）", () => {
  it("连上后拉到工具清单，readOnlyHint 被读出来", async () => {
    const fake = await startFakeMcpServer();
    const client = await McpServerClient.connect(addServer("fake"), logger(), fake.clientTransport);

    const byName = new Map(client.tools.map((t) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual(["boom", "read_thing", "write_thing"]);
    expect(byName.get("read_thing")!.readOnly).toBe(true);
    expect(byName.get("write_thing")!.readOnly).toBe(false);
    expect(byName.get("read_thing")!.description).toBe("Read a thing");

    await client.close();
    await fake.close();
  });

  it("callTool 返回拍平后的文本", async () => {
    const fake = await startFakeMcpServer();
    const client = await McpServerClient.connect(addServer("fake"), logger(), fake.clientTransport);

    expect(await client.callTool("read_thing", { id: "42" })).toBe("read:42");
    expect(fake.calls).toContain("read_thing");

    await client.close();
    await fake.close();
  });

  it("server 报 isError → 抛错（由 buildJsonSchemaTool 包成 Error:）", async () => {
    const fake = await startFakeMcpServer();
    const client = await McpServerClient.connect(addServer("fake"), logger(), fake.clientTransport);

    await expect(client.callTool("boom", {})).rejects.toThrow("kaboom");

    await client.close();
    await fake.close();
  });
});

describe("McpRegistry", () => {
  it("ensureConnected 并发调两次只连一次", async () => {
    addServer("a");
    const connect = vi.fn(async () => fakeConnection(["read_x"]));
    registry = new McpRegistry(store, logger(), connect);

    await Promise.all([registry.ensureConnected(), registry.ensureConnected()]);
    await registry.ensureConnected();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("listTools 返回带 mcp__ 前缀的工具", async () => {
    addServer("km");
    registry = new McpRegistry(store, logger(), async () =>
      fakeConnection(["read_doc", "write_doc"])
    );

    await registry.ensureConnected();

    const tools = registry.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["mcp__km__read_doc", "mcp__km__write_doc"]);
    // readOnly 的免审批，其余需审批
    expect(tools.find((t) => t.name.endsWith("read_doc"))!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name.endsWith("write_doc"))!.annotations?.readOnlyHint).toBeFalsy();
  });

  it("一个 server 连不上 → 它记 error，另一个照常 connected，工具只来自好的那个", async () => {
    addServer("good");
    addServer("bad");

    registry = new McpRegistry(store, logger(), async (server) => {
      if (server.name === "bad") {
        throw new Error("spawn npx ENOENT");
      }
      return fakeConnection(["read_ok"]);
    });

    await registry.ensureConnected();

    const byName = new Map(registry.describe().map((s) => [s.name, s]));
    expect(byName.get("good")!.state).toBe("connected");
    expect(byName.get("good")!.toolCount).toBe(1);
    expect(byName.get("bad")!.state).toBe("error");
    expect(byName.get("bad")!.error).toContain("ENOENT");

    expect(registry.listTools().map((t) => t.name)).toEqual(["mcp__good__read_ok"]);
  });

  it("disabled 的 server 不连接，状态是 disabled", async () => {
    addServer("off", { enabled: false });
    const connect = vi.fn(async () => fakeConnection(["read_x"]));
    registry = new McpRegistry(store, logger(), connect);

    await registry.ensureConnected();

    expect(connect).not.toHaveBeenCalled();
    expect(registry.describe()[0]!.state).toBe("disabled");
    expect(registry.listTools()).toHaveLength(0);
  });

  it("describe 里带工具摘要与免审批标记，供 UI 展示", async () => {
    addServer("km", { autoApproveTools: ["write_doc"] });
    registry = new McpRegistry(store, logger(), async () =>
      fakeConnection(["read_doc", "write_doc"])
    );

    await registry.ensureConnected();

    const tools = registry.describe()[0]!.tools;
    expect(tools.map((t) => `${t.name}:${t.autoApproved}`).sort())
      .toEqual(["read_doc:true", "write_doc:true"]);
  });

  it("reconnect 关掉旧连接再重连", async () => {
    const row = addServer("km");
    const closed: string[] = [];
    let generation = 0;
    registry = new McpRegistry(store, logger(), async () => {
      generation += 1;
      const tag = `gen${generation}`;
      return fakeConnection([`read_${tag}`], () => closed.push(tag));
    });

    await registry.ensureConnected();
    expect(registry.listTools()[0]!.name).toBe("mcp__km__read_gen1");

    const status = await registry.reconnect(row.id);

    expect(closed).toEqual(["gen1"]);
    expect(status.state).toBe("connected");
    expect(registry.listTools()[0]!.name).toBe("mcp__km__read_gen2");
  });

  it("dispose 关闭全部连接", async () => {
    addServer("a");
    addServer("b");
    const closed: string[] = [];
    registry = new McpRegistry(store, logger(), async (server) =>
      fakeConnection(["read_x"], () => closed.push(server.name))
    );

    await registry.ensureConnected();
    await registry.dispose();

    expect(closed.sort()).toEqual(["a", "b"]);
    expect(registry.listTools()).toHaveLength(0);
  });
});
