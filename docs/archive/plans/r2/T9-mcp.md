# T9 · MCP 接入（S8）

> 前置：**T7**（工具模型槽位与 provider catalog 已收敛）。开工前读 `../r1/00-overview.md` §1 + `00-overview.md` §3。
> 施工图：`docs/architecture/14-eva-architecture.md` §4.7、`04-model-adapter-agent-harness.md` §4。

---

## 0. 边界：本轮不做什么

| 不做 | 理由 | 归属 |
|---|---|---|
| **OAuth 授权流**（`mcp_oauth_tokens` 表） | `docs 14 §4.7` 提到，但它要引入回调服务、token 刷新与过期处理三块状态机；而 R2 阶段能接的内部 server 基本都能用静态 token。需要 OAuth 的 server 先在 `headers` 里塞 Bearer。 | R3（FINDINGS 记 `[r3]`） |
| **MCP resources / prompts** | 只接 tools。`resources` 是"给模型读的数据"，与 skill 的定位重叠 —— 引入它等于让 Eva 同时有三套"喂上下文"的机制（skill / memory / resources），先不开这个口子。 | 待 skill 与 resources 的边界想清楚 |
| **扩展声明的 MCP server**（S6 能力槽） | S6 落地后 `McpRegistry` 多一个配置来源即可，是加法。本轮不预留接口 —— 预留的接口没有真实负载喂养，长出来的形状八成是错的。 | S6 |
| **server 进程的资源限制** | stdio server 是子进程，理论上该限内存/CPU。本地单用户场景下过度设计。 | 出现真实问题再做 |

---

## 1. 为什么现在做

Eva 目前的工具集是**写死在代码里的 9 个**（read_file / list_dir / grep / write / edit / bash / web_search / web_fetch / skill）。要连内部系统（知识库、工单、GitLab、数据源）只有两条路：改 harness 代码，或者等 S6 扩展宿主。

MCP 是第三条路，也是**单位代码量能力增益最高**的一条：接一个 server = 写一段配置，agent 立刻多一组工具。对"work agent"这个定位，这是能力天花板从"能读写本地文件"抬到"能操作公司系统"的那一步。

（关于把它排在 S6/S7 之前的完整理由，见 `00-overview.md` §2.1 第 4 条。）

---

## 2. 目标设计

### 2.1 配置的事实源：DB 唯一，文件是导入通道

`docs 14 §4.7` 写的是「`mcp.json` + DB `mcp_servers` 表双来源」。双运行时来源会带来合并与冲突规则，不值得。本方案收敛为：

```
~/.eva/mcp.json  ──启动时同步──>  mcp_servers 表（origin='file'）  ──>  McpRegistry（运行时唯一来源）
UI 新增/编辑     ──────────────>  mcp_servers 表（origin='manual')  ──┘
```

规则（简单到不需要记）：

- **运行时只读表**，不读文件。
- 启动时把 `mcp.json` 的条目 **upsert** 进表并标 `origin='file'`；文件里删掉的 file-origin 条目同步删除。
- `origin='file'` 的条目在 UI 里**只能启用/停用**，不能改内容也不能删（改要去改文件）。UI 上标注"来自 mcp.json"。
- `origin='manual'` 的条目文件同步完全不碰。

这样开发者能把 `mcp.json` 提交进仓库共享配置，同时 UI 的所见即运行时所用。

`mcp.json` 格式与 Claude Code 兼容（降低迁移成本）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"],
      "env": { "FOO": "bar" }
    },
    "internal-km": {
      "url": "https://km.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

### 2.2 运行时：长生命周期 registry，懒连接，失败隔离

```
McpRegistry（AppServices 成员，进程级）
  ├─ ensureConnected()      幂等；首次使用时并发连接所有 enabled server
  ├─ listTools()            → readonly AgentTool[]（已带 mcp__ 前缀）
  ├─ describe()             → readonly McpServerStatus[]（给 REST/UI 看的连接状态）
  ├─ reconnect(id)          单个重连（配置改动后）
  └─ dispose()              进程退出时关闭全部 client
```

三条硬规则：

1. **不在 `createAgent` 里连接**。stdio server 要 spawn 进程，几百毫秒起；agent 是 per-run 构造的。连接归 registry，`createAgent` 只 `listTools()`。
2. **一个 server 挂掉不影响其它人**：连接失败 → 该 server 记 `status: "error" + message`，工具缺席，run 正常跑。**永远不要因为 MCP 不可用而让对话失败。**
3. **工具调用有超时**（默认 30s）。MCP server 是外部进程/服务，卡住不能拖死 agent loop。

### 2.3 工具映射

| MCP 概念 | Eva 侧 |
|---|---|
| server 名字 | 工具名前缀：`mcp__<server>__<tool>`（`server` 限 `[a-z0-9_-]+`，建表时唯一） |
| tool.inputSchema（JSON Schema） | `jsonSchema()`（`ai` 从 `@ai-sdk/provider-utils` re-export）→ `tool({ inputSchema })` |
| tool.description | 原样透传（MCP server 作者写的触发时机说明比我们瞎猜的准） |
| tool.annotations.readOnlyHint | `true` → 不需审批；否则默认**需要审批** |
| 调用结果 content[] | 拍平成文本（text 直接拼、image/resource 写成占位说明） |

**审批默认开**是有意的：MCP server 是第三方代码，能发 HTTP、能改文件、能花钱。协议自己提供了 `readOnlyHint`，我们尊重它；没声明就按危险处理。用户可以在 server 配置里用 `autoApproveTools: ["searchX", "readY"]` 放行具体工具。

这一层**不需要新机制** —— `AgentTool.requiresApproval` + `withApproval` 是 R1 T0.4 就建好的闸门，MCP 工具只是又一批带标记的工具。

---

## 3. 涉及文件

### 新增

| 文件 | 内容 |
|---|---|
| `apps/server/src/db/migrations/0018_mcp_servers.sql` | 建表 |
| `apps/server/src/db/repositories/mcp-server-repository.ts` | CRUD + file-origin 同步 |
| `apps/server/src/services/mcp/mcp-config-file.ts` | 读 `~/.eva/mcp.json` + zod 校验 + 同步进表 |
| `apps/server/src/services/mcp/mcp-client.ts` | 单个 server 的连接与调用（transport 二选一、超时、结果拍平） |
| `apps/server/src/services/mcp/mcp-registry.ts` | `McpRegistry` |
| `apps/server/src/services/mcp/mcp-tools.ts` | MCP tool → `AgentTool` 映射 |
| `apps/server/src/services/mcp/index.ts` | re-export |
| `apps/server/src/routes/mcp-servers.ts` | REST |
| `packages/harness/src/tools/build-json-schema-tool.ts` | `buildJsonSchemaTool`（JSON Schema 版的 `buildTool`） |
| `apps/web/src/features/settings/components/mcp-settings.tsx` | Settings 的 MCP tab |
| `apps/web/src/features/settings/hooks/use-mcp-servers.ts` | 前端数据 |
| `tests/mcp-tools.test.ts` | schema/命名/审批标记/结果拍平 |
| `tests/mcp-registry.test.ts` | 懒连接、失败隔离、超时（用 InMemoryTransport 起一个假 server） |
| `tests/mcp-config-file.test.ts` | `mcp.json` 解析与同步规则 |

### 修改

| 文件 | 动作 |
|---|---|
| `apps/server/package.json` | 加 `@modelcontextprotocol/sdk` |
| `apps/server/src/db/schema.ts` | `mcpServers` 表 |
| `apps/server/src/types/common.ts` | `AppServices.mcp` |
| `apps/server/src/services/index.ts` | 装配 `McpRegistry` |
| `apps/server/src/deps.ts` | 启动时同步 `mcp.json` |
| `apps/server/src/services/agent-factory.ts` | `createAgent` 时把 `mcp.listTools()` 并入 additionalTools |
| `apps/server/src/agent.ts` | `ConfiguredAgentOptions.extraTools?: readonly AgentTool[]` |
| `apps/server/src/routes/index.ts` | 注册路由 |
| `apps/server/src/index.ts` / `server.ts` | 进程退出时 `mcp.dispose()` |
| `packages/harness/src/tools.ts` / `index.ts` | 导出 `buildJsonSchemaTool` |
| `packages/shared/src/index.ts` | `McpServerConfig` / `McpServerStatus` 契约 |
| `apps/web/src/features/settings/settings-page.tsx` | 加 MCP tab |

---

## 4. 步骤

### Step 0 · 装依赖 + 确认 SDK 形状

```bash
pnpm --filter @eva/server add @modelcontextprotocol/sdk
```

**开工前先确认**（本 spec 按下面的形状写，装完请核对实际版本，不一致就按实际的改并在 commit 正文记一句）：

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";   // 测试用

const client = new Client({ name: "eva", version: "0.1.0" });
await client.connect(transport);
const { tools } = await client.listTools();      // tools[i]: { name, description?, inputSchema, annotations? }
const result = await client.callTool({ name, arguments: input });  // result.content: Array<{type:"text",text} | ...>
await client.close();
```

同时确认 `ai` 确实 re-export 了 `jsonSchema`（`grep -n "jsonSchema" node_modules/ai/dist/index.d.ts` —— 应该在第 7 行的 `@ai-sdk/provider-utils` re-export 列表里）。

### Step 1 · harness：JSON Schema 版工具构造器

`packages/harness/src/tools/build-json-schema-tool.ts`：

```ts
import { jsonSchema, tool, type Tool } from "ai";

import type { AgentTool } from "../tools.js";

export interface JsonSchemaToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema 原样（来自 MCP server 的 inputSchema）。 */
  readonly inputSchema: unknown;
  readonly execute: (input: unknown) => Promise<string>;
  readonly readOnly?: boolean;
  readonly requiresApproval?: boolean;
}

/**
 * `buildTool` 的 JSON Schema 版本。
 *
 * 为什么需要两个构造器：内建工具用 zod（写起来类型安全），外部工具（MCP）只能
 * 拿到 JSON Schema，硬转 zod 既有损又没必要 —— AI SDK 两种都吃。
 * 错误包装与 `buildTool` 保持一致（`[Tool Error] ...`），这样 stream-part-mapper
 * 的状态判定对两类工具是同一套。
 */
export const buildJsonSchemaTool = (
  definition: JsonSchemaToolDefinition
): AgentTool => {
  const built: Tool = tool({
    description: definition.description,
    inputSchema: jsonSchema(definition.inputSchema as never),
    execute: async (input: unknown) => {
      try {
        return await definition.execute(input);
      } catch (error) {
        return `[Tool Error] ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
  });

  return {
    name: definition.name,
    tool: built,
    ...(definition.readOnly !== undefined ? { readOnly: definition.readOnly } : {}),
    ...(definition.requiresApproval !== undefined
      ? { requiresApproval: definition.requiresApproval }
      : {})
  };
};
```

> `[Tool Error]` 这个前缀是 `buildTool` 定的约定，`stream-part-mapper.ts` 靠它判 error 状态。两个构造器必须用同一个前缀 —— 建议把它提成 `tools.ts` 里的导出常量 `TOOL_ERROR_PREFIX`，两处引用，别抄字面量。

### Step 2 · 数据层

`0018_mcp_servers.sql`：

```sql
CREATE TABLE `mcp_servers` (
  `id` text PRIMARY KEY NOT NULL,
  -- 工具名前缀。限 [a-z0-9_-]+，唯一 —— mcp__<name>__<tool> 必须能被稳定解析
  `name` text NOT NULL,
  -- manual = UI 建的；file = 从 mcp.json 同步来的（UI 只能启停）
  `origin` text NOT NULL DEFAULT 'manual',
  `transport` text NOT NULL,
  `command` text,
  `args` text NOT NULL DEFAULT '[]',
  `env` text NOT NULL DEFAULT '{}',
  `url` text,
  `headers` text NOT NULL DEFAULT '{}',
  -- 免审批工具名白名单（不含 mcp__ 前缀，就写 MCP 侧原名）
  `auto_approve_tools` text NOT NULL DEFAULT '[]',
  `enabled` integer NOT NULL DEFAULT 1,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mcp_servers_name` ON `mcp_servers` (`name`);
```

journal 追加 `idx: 18, tag: "0018_mcp_servers"`。

`db/schema.ts` 加表。`mcp-server-repository.ts` 提供 `listAll` / `listEnabled` / `findById` / `findByName` / `create` / `update` / `deleteById` / `replaceFileOrigin(configs)`（后者是文件同步用的原子替换：删掉不在列表里的 file-origin 行，upsert 列表里的行）。

`packages/shared` 契约：

```ts
export type McpTransport = "stdio" | "http";
export type McpOrigin = "manual" | "file";

export interface McpServerConfig {
  id: string;
  name: string;
  origin: McpOrigin;
  transport: McpTransport;
  command?: string;
  args: readonly string[];
  /** 值可能含密钥，列表接口里做遮蔽（只回 key 名）。 */
  envKeys: readonly string[];
  url?: string;
  headerKeys: readonly string[];
  autoApproveTools: readonly string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type McpConnectionState = "connected" | "error" | "disabled";

export interface McpServerStatus {
  id: string;
  name: string;
  state: McpConnectionState;
  toolCount: number;
  error?: string;
  connectedAt?: string;
}
```

> `env` / `headers` 的**值不回给前端**（只回 key 名）——它们是密钥。和 `Provider.hasApiKey` 一个道理。

### Step 3 · `mcp.json` 同步

`services/mcp/mcp-config-file.ts`：

```ts
const mcpServerFileSchema = z.union([
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    autoApproveTools: z.array(z.string()).default([]),
    enabled: z.boolean().default(true)
  }),
  z.object({
    url: z.string().url(),
    headers: z.record(z.string()).default({}),
    autoApproveTools: z.array(z.string()).default([]),
    enabled: z.boolean().default(true)
  })
]);

const mcpConfigFileSchema = z.object({
  mcpServers: z.record(mcpServerFileSchema).default({})
});

/** server 名字直接进工具名，必须是稳定可解析的标识符。 */
const SERVER_NAME_PATTERN = /^[a-z0-9_-]+$/;

/**
 * 把 ~/.eva/mcp.json 同步进 mcp_servers 表（origin='file'）。
 * 文件不存在 / 解析失败 → 记日志后返回，**不抛**（配置文件坏了不该让服务起不来）。
 * 名字不合法的条目单独跳过并 warn，其余条目照常同步。
 */
export const syncMcpConfigFile = (db: AppDatabase, logger: Logger, filePath: string): void => { /* ... */ };
```

**【测试先行】`tests/mcp-config-file.test.ts`**：stdio 与 http 两种形状都能解析；名字含大写/空格 → 跳过且其余条目仍同步；文件不存在 → 无异常无写库；文件里删掉一条 → 表里对应 file-origin 行消失；manual 行不受影响；坏 JSON → 不抛、记 error。

### Step 4 · 单 server 客户端

`services/mcp/mcp-client.ts`：

```ts
/** MCP 工具调用超时。外部进程/服务卡住不能拖死 agent loop；30s 够慢工具跑完。 */
const CALL_TIMEOUT_MS = 30_000;

/** 单条工具输出的注入上限。超出截断并提示 —— 和 tool-overflow 同一个思路。 */
const MAX_OUTPUT_CHARS = 24_000;

export interface McpToolDescriptor {
  readonly name: string;              // MCP 侧原名
  readonly description: string;
  readonly inputSchema: unknown;
  readonly readOnly: boolean;         // 取自 annotations.readOnlyHint
}

export class McpServerClient {
  static async connect(config: McpServerRow): Promise<McpServerClient>
  get tools(): readonly McpToolDescriptor[]
  callTool(toolName: string, input: unknown): Promise<string>
  close(): Promise<void>
}
```

- `connect` 按 `transport` 建 `StdioClientTransport` / `StreamableHTTPClientTransport`，`client.connect` 后 `listTools()` 缓存描述符。
- `callTool` 用 `Promise.race` 加超时；结果 `content[]` 拍平：
  - `type: "text"` → `text`
  - `type: "image"` → `[image ${mimeType}, ${bytes} bytes — not inlined]`
  - `type: "resource"` → `[resource ${uri}]`
  - `isError: true` → 抛错（由 `buildJsonSchemaTool` 包成 `[Tool Error] ...`）
- 拍平后超 `MAX_OUTPUT_CHARS` → 截断并追加 `\n[... truncated N chars]`。

### Step 5 · 工具映射

`services/mcp/mcp-tools.ts`：

```ts
/** 工具名前缀。双下划线分隔，与 Claude Code 的 mcp__server__tool 一致。 */
export const mcpToolName = (server: string, tool: string): string =>
  `mcp__${server}__${tool}`;

/**
 * MCP 工具 → AgentTool。
 *
 * 审批策略：readOnlyHint 为真 → 免审批（协议自己声明了它无副作用）；
 * 在 server 的 autoApproveTools 白名单里 → 免审批；
 * 其余一律需审批 —— MCP server 是第三方代码，默认按危险处理。
 */
export const toAgentTools = (
  server: McpServerRow,
  client: McpServerClient
): readonly AgentTool[] =>
  client.tools.map((descriptor) => {
    const autoApproved =
      descriptor.readOnly || server.autoApproveTools.includes(descriptor.name);

    return buildJsonSchemaTool({
      name: mcpToolName(server.name, descriptor.name),
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      readOnly: descriptor.readOnly,
      ...(autoApproved ? {} : { requiresApproval: true }),
      execute: (input) => client.callTool(descriptor.name, input)
    });
  });
```

**【测试先行】`tests/mcp-tools.test.ts`**：命名格式；`readOnlyHint: true` → 无 `requiresApproval`；白名单命中 → 无 `requiresApproval`；都不满足 → `requiresApproval: true`；JSON Schema 原样进 `inputSchema`；`callTool` 抛错 → 返回 `[Tool Error] ...` 而不是抛出。

### Step 6 · registry

`services/mcp/mcp-registry.ts`：

```ts
export class McpRegistry {
  private clients = new Map<string, McpServerClient>();
  private statuses = new Map<string, McpServerStatus>();
  private connecting: Promise<void> | undefined;

  constructor(private readonly repo: McpServerRepository, private readonly logger: Logger) {}

  /**
   * 幂等地把所有 enabled server 连上。并发连接（Promise.allSettled），
   * 单个失败只记状态不抛 —— MCP 不可用绝不能让对话失败。
   */
  async ensureConnected(): Promise<void> {
    this.connecting ??= this.connectAll().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  /** 已连上的 server 的全部工具。未连接时返回空数组（调用方应先 ensureConnected）。 */
  listTools(): readonly AgentTool[]

  describe(): readonly McpServerStatus[]

  /** 配置变更后重连单个 server（先 close 旧 client）。 */
  async reconnect(id: string): Promise<McpServerStatus>

  async dispose(): Promise<void>
}
```

装配进 `AppServices.mcp`。`deps.ts` 里 `syncMcpConfigFile(...)` 之后**不要**立刻 connect —— 留给第一次 run 触发（启动更快，且没配 MCP 的用户零开销）。

`agent-factory.ts` 的 `createAgent` 变 async？**不要**。改为：路由在 `createAgent` 之前 `await app.services.mcp.ensureConnected()`，然后 `createAgent` 里同步 `listTools()`。这样 factory 保持同步，异步只出现在路由这一层。

```ts
// routes/runs.ts
await app.services.mcp.ensureConnected();
const agent = app.services.agents.createAgent({ models, requestApproval, workspace, extraTools: app.services.mcp.listTools() });
```

`agent.ts` 的 `ConfiguredAgentOptions` 加 `extraTools?: readonly AgentTool[]`，在工具装配末尾并入。

**【测试先行】`tests/mcp-registry.test.ts`**：用 `InMemoryTransport.createLinkedPair()` 起一个声明两个工具（一个 `readOnlyHint`）的假 server：
- `ensureConnected` 并发调两次只连一次（用连接计数断言）；
- `listTools()` 返回 2 个带前缀的工具；
- 一个 server 连接抛错 → `describe()` 里它是 `state: "error"`，另一个仍 `connected`，`listTools()` 只含后者的工具；
- `callTool` 超时 → 返回 `[Tool Error] ...` 且含 "timed out"；
- `dispose()` 后 client 全部 close。

> `InMemoryTransport` 需要在测试里手搓一个 `Server`（SDK 的 server 侧），注册两个 tool handler。这段搭建代码放在 `tests/helpers/fake-mcp-server.ts`（`tests/` 下第一个 helper 文件，可以建 `helpers/` 目录）。

### Step 7 · REST

```
GET    /api/v1/mcp-servers                 → { servers: McpServerConfig[], statuses: McpServerStatus[] }
POST   /api/v1/mcp-servers                 新增 manual；名字冲突 409；名字非法 400
PUT    /api/v1/mcp-servers/:id             改；origin='file' 时只允许 { enabled }，其余字段 400
DELETE /api/v1/mcp-servers/:id             origin='file' → 400（去改 mcp.json）
POST   /api/v1/mcp-servers/:id/reconnect   → McpServerStatus
```

写操作成功后 `await app.services.mcp.reconnect(id)`（或 disabled 时断开），让状态立刻反映配置。

### Step 8 · 前端 MCP tab

`mcp-settings.tsx`：一个列表，每行 = 名字 + transport 徽标 + 状态点（connected / error / disabled）+ 工具数 + "来自 mcp.json" 标记（file-origin）+ 启停开关 + 重连按钮 + 展开看工具列表。底部"添加 server"表单（stdio: command + args + env；http: url + headers）。

`settings-page.tsx` 的 `NAV_ITEMS` 加 `{ id: "mcp", label: "MCP", icon: Plug }`。

错误展示：`state: "error"` 时把 `error` 文本显示在行下方（用户要能看到"npx: command not found"这种真实原因）。

### Step 9 · 生命周期收尾

`apps/server/src/index.ts`（或 `server.ts`，看进程收尾逻辑在哪）加：进程 `SIGTERM` / `SIGINT` / `beforeExit` 时 `await app.services.mcp.dispose()`。stdio server 是子进程，**不 close 就会留孤儿进程**。

---

## 5. 验收

- [ ] `pnpm typecheck && pnpm test` 全绿；3 个新测试文件从 RED 到 GREEN
- [ ] 手工：写 `~/.eva/mcp.json` 配 `@modelcontextprotocol/server-filesystem` → 重启 server → Settings/MCP 里显示 connected + 工具数
- [ ] 手工：问"用 MCP 列一下 /tmp 下的文件" → agent 调 `mcp__filesystem__list_directory` 成功
- [ ] 手工：该工具若非 readOnly → 先弹审批卡片；把它加进 `autoApproveTools` 后重连 → 不再弹
- [ ] 手工：把 `command` 改成不存在的命令 → 该 server 显示 error + 真实原因；**发消息照常可用**（其它工具可用，对话不失败）
- [ ] 手工：UI 里试图删除 file-origin server → 400 且提示去改 mcp.json
- [ ] 手工：退出 Eva → `ps aux | grep server-filesystem` 无残留进程
- [ ] `GET /api/v1/mcp-servers` 的响应里**不含** env / headers 的值（只有 key 名）

## 6. 坑

1. **stdio server 的 PATH**：Electron 打包后 `process.env.PATH` 很窄，`npx` 可能找不到。`StdioClientTransport` 的 env 要用 `main.ts` 里已经加载的 `userShellEnv`——但 server 是 UtilityProcess，它继承的 env 已经是修好的（R1 S0 做过）。**验证一遍**：在打包版里配一个 `npx` server 能不能连上；连不上就在 `mcp-client.ts` 里显式合并 `process.env.PATH`。
2. **`jsonSchema()` 对不规范 schema 的容忍度**：有些 MCP server 的 `inputSchema` 缺 `type: "object"` 或用了 `$ref`。连接时对每个工具做一次最小校验（顶层是对象且有 `type` 或 `properties`），不合格的工具**跳过并 warn**，不要让一个坏 schema 废掉整个 server。
3. **工具名长度**：`mcp__<server>__<tool>` 可能超过某些 provider 的工具名长度上限（OpenAI 是 64 字符）。超长时截断 server 名并保留 hash 后缀，或直接 warn 跳过。**先 warn 跳过**（简单、可见），需要时再做截断映射。
4. **`ensureConnected` 的并发**：多个 run 同时开始会同时调它。用 `this.connecting ??= ...` 的单飞模式（已在 §Step 6 写明），别用锁库。
5. **别把 MCP 工具塞进 `additionalTools`**：`AgentRunInput.additionalTools` 现在是记忆工具在用的通道（per-run 动态）。MCP 工具是 per-process 稳定的，走 `ConfiguredAgentOptions.extraTools` 更准确 —— 两个通道语义不同，别混用。
