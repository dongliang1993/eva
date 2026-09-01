/**
 * MCP（Model Context Protocol）接入的前后端契约。
 *
 * 单独成文件而不是塞进 index.ts：MCP 是一个自成一体的子系统，且 index.ts 是
 * 多人同时改的热点文件。
 *
 * 存储模型：`~/.eva/mcp.json` 是唯一事实源（UI 增删改都写文件，server 只在
 * 运行时读它）。env / headers 的值随之回传 —— 文件本身是明文，UI 在本机
 * 信任域（见 docs/current/data-ownership.md）。
 */

export type McpTransport = "stdio" | "http";

/** server 配置的对外形状。id = mcp.json 里的条目名。 */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  url?: string;
  headers: Readonly<Record<string, string>>;
  autoApproveTools: readonly string[];
  enabled: boolean;
}

export type McpConnectionState = "connected" | "error" | "disabled";

/** 一个工具参数的摘要 —— 从 inputSchema 的 properties 派生，供 UI 展示参数表。 */
export interface McpToolParam {
  name: string;
  /** JSON Schema 的 type 原样（"string"/"number"/…；数组型折成 "a | b"）。 */
  type: string;
  required: boolean;
  description: string;
}

export interface McpToolSummary {
  /** MCP 侧原名（不含 mcp__ 前缀）。 */
  name: string;
  description: string;
  /** 免审批：协议声明了 readOnlyHint，或落在 autoApproveTools 白名单里。 */
  autoApproved: boolean;
  /** 参数表 —— schema properties 声明序。 */
  params: readonly McpToolParam[];
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

/** 新增 / 修改 server 的入参。 */
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
