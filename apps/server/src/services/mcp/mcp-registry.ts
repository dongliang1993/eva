import type { AgentTool } from "@eva/harness";
import type { McpServerStatus } from "@eva/shared";

import type {
  McpServerRepository,
  McpServerRow
} from "../../db/repositories/mcp-server-repository.js";
import { McpServerClient } from "./mcp-client.js";
import type { McpLogger } from "./mcp-config-file.js";
import { toAgentTools, toToolSummaries, type McpToolInvoker } from "./mcp-tools.js";

/** registry 眼里的一条连接：能列工具、能调用、能关。 */
export interface McpConnection extends McpToolInvoker {
  close(): Promise<void>;
}

/**
 * 建立连接的方式。默认走真实的 MCP 协议；测试注入假连接。
 * 把它做成参数而不是内部 new —— registry 关心的是"连上了/没连上"，不关心怎么连的。
 */
export type McpConnect = (row: McpServerRow, logger: McpLogger) => Promise<McpConnection>;

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
    private readonly repo: McpServerRepository,
    private readonly logger: McpLogger,
    private readonly connect: McpConnect = defaultConnect
  ) {}

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

    for (const row of this.repo.listAll()) {
      const connection = this.connections.get(row.id);

      if (connection) {
        tools.push(...toAgentTools(row, connection, this.logger));
      }
    }

    return tools;
  }

  /**
   * 每个 server 的连接状态。
   * 调用方应先 `ensureConnected()` —— 否则 enabled 但还没连过的 server 只能报
   * "未连接"，那对用户是个没信息量的答案。
   */
  describe(): readonly McpServerStatus[] {
    return this.repo.listAll().map((row) => this.statusOf(row));
  }

  /** 配置变更后重连单个 server（先关旧连接）。disabled 则只断开。 */
  async reconnect(id: string): Promise<McpServerStatus> {
    await this.disconnect(id);

    const row = this.repo.findById(id);

    if (!row) {
      return {
        id,
        name: id,
        state: "error",
        toolCount: 0,
        tools: [],
        error: "server 已不存在"
      };
    }

    if (!row.enabled) {
      this.statuses.delete(row.id);
      return this.statusOf(row);
    }

    await this.connectOne(row);

    return this.statusOf(row);
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
    const enabled = this.repo.listEnabled();

    if (enabled.length === 0) {
      return;
    }

    // 并发连接：一个慢 server 不该拖住其它人的首个 run
    await Promise.allSettled(enabled.map((row) => this.connectOne(row)));
  }

  private async connectOne(row: McpServerRow): Promise<void> {
    try {
      const connection = await this.connect(row, this.logger);

      this.connections.set(row.id, connection);
      this.statuses.set(row.id, {
        id: row.id,
        name: row.name,
        state: "connected",
        toolCount: connection.tools.length,
        tools: toToolSummaries(row, connection),
        connectedAt: new Date().toISOString()
      });

      this.logger.info(
        { server: row.name, toolCount: connection.tools.length },
        "MCP server 已连接"
      );
    } catch (error) {
      const message = toErrorMessage(error);

      this.statuses.set(row.id, {
        id: row.id,
        name: row.name,
        state: "error",
        toolCount: 0,
        tools: [],
        error: message
      });

      // 只记不抛：MCP 不可用绝不能让对话失败
      this.logger.error({ err: error, server: row.name }, "MCP server 连接失败");
    }
  }

  private statusOf(row: McpServerRow): McpServerStatus {
    if (!row.enabled) {
      return { id: row.id, name: row.name, state: "disabled", toolCount: 0, tools: [] };
    }

    return (
      this.statuses.get(row.id) ?? {
        id: row.id,
        name: row.name,
        state: "error",
        toolCount: 0,
        tools: [],
        error: "未连接（重启服务或点重连）"
      }
    );
  }
}
