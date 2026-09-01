import type { AgentTool } from "@eva/harness";
import type { McpServerConfig, McpServerStatus } from "@eva/shared";

import { McpServerClient } from "./mcp-client.js";
import type { McpLogger, McpConfigStore } from "./mcp-config-store.js";
import { toAgentTools, toToolSummaries, type McpToolInvoker } from "./mcp-tools.js";

/** registry 眼里的一条连接：能列工具、能调用、能关。 */
export interface McpConnection extends McpToolInvoker {
  close(): Promise<void>;
}

/**
 * 建立连接的方式。默认走真实的 MCP 协议；测试注入假连接。
 * 把它做成参数而不是内部 new —— registry 关心的是"连上了/没连上"，不关心怎么连的。
 */
export type McpConnect = (
  server: McpServerConfig,
  logger: McpLogger
) => Promise<McpConnection>;

const defaultConnect: McpConnect = (row, logger) => McpServerClient.connect(row, logger);

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 进程级的 MCP 连接注册表。
 *
 * 三条硬规则（`docs/plans/r2/T9-mcp.md` §2.2）：
 * 1. 连接不发生在 createAgent 里 —— stdio 要 spawn 进程，而 agent 是 per-run 构造的；
 * 2. 一个 server 挂掉不影响其它人，也绝不让对话失败；
 * 3. 调用有超时（在 McpServerClient 里）。
 */
export class McpRegistry {
  private readonly connections = new Map<string, McpConnection>();
  private readonly statuses = new Map<string, McpServerStatus>();
  /** 单飞：并发的首次调用共享同一个连接过程。 */
  private connecting: Promise<void> | undefined;
  /** 首轮连接是否已跑过。跑过之后 ensureConnected 直接返回，配置变更走 reconnect。 */
  private attempted = false;

  constructor(
    private readonly store: McpConfigStore,
    private readonly logger: McpLogger,
    private readonly connect: McpConnect = defaultConnect
  ) { }

  /** 幂等地把所有 enabled server 连上；已经连过一轮就直接返回。 */
  async ensureConnected(): Promise<void> {
    if (this.attempted) {
      return;
    }

    this.connecting ??= this.connectAll().finally(() => {
      this.connecting = undefined;
      this.attempted = true;
    });

    return this.connecting;
  }

  /** 已连上的 server 的全部工具（已带 mcp__ 前缀）。 */
  listTools(): readonly AgentTool[] {
    const tools: AgentTool[] = [];

    for (const server of this.store.listAll()) {
      const connection = this.connections.get(server.id);

      if (connection) {
        tools.push(...toAgentTools(server, connection, this.logger));
      }
    }

    return tools;
  }

  /**
   * 每个 server 的连接状态。只读不连 —— 启动预热(见 app.ts)或首个 run 负责建连接。
   * 预热没跑完就调它的话,enabled 但还没连过的 server 报"未连接"。
   */
  describe(): readonly McpServerStatus[] {
    return this.store.listAll().map((server) => this.statusOf(server));
  }

  /** 配置变更后重连单个 server（先关旧连接）。disabled 则只断开。 */
  async reconnect(id: string): Promise<McpServerStatus> {
    await this.disconnect(id);

    const server = this.store.findById(id);

    if (!server) {
      return {
        id,
        name: id,
        state: "error",
        toolCount: 0,
        tools: [],
        error: "server 已不存在"
      };
    }

    if (!server.enabled) {
      this.statuses.delete(server.id);
      return this.statusOf(server);
    }

    await this.connectOne(server);

    return this.statusOf(server);
  }

  /** 关闭并忘掉一个 server 的连接（删除 / 停用时用）。 */
  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id);

    if (!connection) {
      return;
    }

    this.connections.delete(id);
    this.statuses.delete(id);

    try {
      await connection.close();
    } catch (error) {
      // 关闭失败无所谓,连接已经从表里摘掉了;但要留痕,否则孤儿进程无从排查
      this.logger.warn({ err: error, serverId: id }, "关闭 MCP 连接失败");
    }
  }

  /** 进程退出时关闭全部连接 —— stdio server 是子进程，不关会留孤儿。 */
  async dispose(): Promise<void> {
    const ids = [...this.connections.keys()];

    await Promise.allSettled(ids.map((id) => this.disconnect(id)));

    this.attempted = false;
  }

  private async connectAll(): Promise<void> {
    const enabled = this.store.listEnabled();

    if (enabled.length === 0) {
      return;
    }

    // 并发连接：一个慢 server 不该拖住其它人的首个 run
    await Promise.allSettled(enabled.map((server) => this.connectOne(server)));
  }

  private async connectOne(server: McpServerConfig): Promise<void> {
    try {
      const connection = await this.connect(server, this.logger);

      this.connections.set(server.id, connection);
      this.statuses.set(server.id, {
        id: server.id,
        name: server.name,
        state: "connected",
        toolCount: connection.tools.length,
        tools: toToolSummaries(server, connection),
        connectedAt: new Date().toISOString()
      });

      this.logger.info(
        { server: server.name, toolCount: connection.tools.length },
        "MCP server 已连接"
      );
    } catch (error) {
      const message = toErrorMessage(error);

      this.statuses.set(server.id, {
        id: server.id,
        name: server.name,
        state: "error",
        toolCount: 0,
        tools: [],
        error: message
      });

      // 只记不抛：MCP 不可用绝不能让对话失败
      this.logger.error({ err: error, server: server.name }, "MCP server 连接失败");
    }
  }

  private statusOf(server: McpServerConfig): McpServerStatus {
    if (!server.enabled) {
      return { id: server.id, name: server.name, state: "disabled", toolCount: 0, tools: [] };
    }

    return (
      this.statuses.get(server.id) ?? {
        id: server.id,
        name: server.name,
        state: "error",
        toolCount: 0,
        tools: [],
        error: "未连接（重启服务或点重连）"
      }
    );
  }
}
