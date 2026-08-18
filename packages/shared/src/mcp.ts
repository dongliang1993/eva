/**
 * MCP（Model Context Protocol）接入的前后端契约。
 *
 * 单独成文件而不是塞进 index.ts：MCP 是一个自成一体的子系统，且 index.ts 是
 * 多人同时改的热点文件。
 */

export type McpTransport = "stdio" | "http";

/** file = 来自 ~/.eva/mcp.json（UI 只能启停）；manual = UI 创建。 */
export type McpOrigin = "manual" | "file";

/**
 * server 配置的对外形状。
 *
 * env / headers 的**值不出现在这里** —— 它们是密钥，只回 key 名让 UI 能显示
 * "配了哪几项"。与 `Provider.hasApiKey` 同一个原则。
 */
export interface McpServerConfig {
  id: string;
  name: string;
  origin: McpOrigin;
  transport: McpTransport;
  command?: string;
  args: readonly string[];
  envKeys: readonly string[];
  url?: string;
  headerKeys: readonly string[];
  autoApproveTools: readonly string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type McpConnectionState = "connected" | "error" | "disabled";

export interface McpToolSummary {
  /** MCP 侧原名（不含 mcp__ 前缀）。 */
  name: string;
  description: string;
  /** 免审批：协议声明了 readOnlyHint，或落在 autoApproveTools 白名单里。 */
  autoApproved: boolean;
}

export interface McpServerStatus {
  id: string;
  name: string;
  state: McpConnectionState;
  toolCount: number;
  tools: readonly McpToolSummary[];
  /** state=error 时的真实原因，直接展示给用户（如 "npx: command not found"）。 */
  error?: string;
  connectedAt?: string;
}

/** `GET /api/v1/mcp-servers` 的响应。 */
export interface McpServersPayload {
  servers: readonly McpServerConfig[];
  statuses: readonly McpServerStatus[];
}

/** 新增 / 修改 server 的入参（写操作才带 env / headers 的值）。 */
export interface McpServerInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  url?: string;
  headers?: Readonly<Record<string, string>>;
  autoApproveTools?: readonly string[];
  enabled?: boolean;
}
