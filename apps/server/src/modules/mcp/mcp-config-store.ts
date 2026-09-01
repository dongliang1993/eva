import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import type { McpServerConfig } from "@eva/shared";

import { evaDataDir } from "../../paths.js";

/**
 * `~/.eva/mcp.json` —— MCP server 的唯一事实源。
 *
 * 形状对齐行业事实标准（Claude Desktop / Cursor / VS Code 的 `mcpServers`）:
 * 用户从任何工具的文档里复制一段贴进来就能用。UI 的增删改都经这里写回
 * 文件（temp + rename 原子写），server 运行时也只读它 —— 没有第二份存储。
 *
 * id = 条目名。名字即身份:改名就是删旧条目建新条目（UI 侧按"改"对待）。
 */

/** 只需要这三档的结构化日志 —— 兼容 Fastify logger 与 pino logger。 */
export interface McpLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const sharedEntryFields = {
  autoApproveTools: z.array(z.string()).default([]),
  enabled: z.boolean().default(true)
};

const stdioEntrySchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  ...sharedEntryFields
});

const httpEntrySchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  ...sharedEntryFields
});

/** 同时给了 command 和 url 时按 stdio 解释（union 取首个匹配）。 */
const entrySchema = z.union([stdioEntrySchema, httpEntrySchema]);

const configFileSchema = z.object({
  mcpServers: z.record(z.string(), entrySchema).default({})
});

export type McpEntry = z.infer<typeof entrySchema>;

/** 一条 server 的可写字段（create / update 共用；transport 决定带的字段）。 */
export interface McpServerFields {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly autoApproveTools?: readonly string[] | undefined;
  readonly enabled?: boolean | undefined;
}

/** 默认配置文件位置（与 DB、tool-overflow 同一个用户数据根）。 */
export const mcpConfigFilePath = (): string => path.join(evaDataDir(), "mcp.json");

/** 文件里的一条条目 → 对外配置形状。transport 按字段推断,与 zod union 同序。 */
const entryToConfig = (name: string, entry: McpEntry): McpServerConfig =>
  "command" in entry
    ? {
      id: name,
      name,
      transport: "stdio",
      command: entry.command,
      args: entry.args,
      env: entry.env,
      headers: {},
      autoApproveTools: entry.autoApproveTools,
      enabled: entry.enabled
    }
    : {
      id: name,
      name,
      transport: "http",
      url: entry.url,
      args: [],
      env: {},
      headers: entry.headers,
      autoApproveTools: entry.autoApproveTools,
      enabled: entry.enabled
    };

/**
 * 一次写操作的结构：先 clone 当前文件内容 → 改内存里的副本 → 原子写回。
 * 读-改-写在同进程内串行（server 是唯一写方），没有并发窗口。
 */
const withConfig = <T>(
  filePath: string,
  mutate: (servers: Map<string, McpEntry>) => T
): T => {
  const servers = readConfigMap(filePath);
  const result = mutate(servers);

  writeConfigMap(filePath, servers);

  return result;
};

const readConfigMap = (filePath: string): Map<string, McpEntry> => {
  if (!existsSync(filePath)) {
    return new Map();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    // 文件归用户手管,坏 JSON 不该让 MCP 整个子系统挂掉。这里按"没有 server"处理;
    // 写路径会覆盖掉坏文件 —— 谁手滑改坏的,日志里有痕迹可查。
    throw new McpConfigError(`mcp.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  const validated = configFileSchema.safeParse(parsed);

  if (!validated.success) {
    throw new McpConfigError(
      `mcp.json 结构不合法：${validated.error.issues[0]?.message ?? "未知原因"}`
    );
  }

  return new Map(Object.entries(validated.data.mcpServers));
};

/** temp + rename 原子写：读到一半或写一半断电,文件都停在完整的一版上。 */
const writeConfigMap = (filePath: string, servers: Map<string, McpEntry>): void => {
  const payload = {
    mcpServers: Object.fromEntries([...servers.entries()].sort(([a], [b]) => a.localeCompare(b)))
  };

  const temp = path.join(mkdtempSync(path.join(tmpdir(), "eva-mcp-")), "mcp.json");

  try {
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    renameSync(temp, filePath);
  } finally {
    rmSync(path.dirname(temp), { recursive: true, force: true });
  }
};

/** 配置文件不可读/不合法 —— 让调用方转成 4xx/5xx,而不是静默当"没有配置"。 */
export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

const fieldsToEntry = (fields: McpServerFields): McpEntry =>
  fields.transport === "stdio"
    ? {
      command: fields.command ?? "",
      args: [...(fields.args ?? [])],
      env: { ...(fields.env ?? {}) },
      autoApproveTools: [...(fields.autoApproveTools ?? [])],
      enabled: fields.enabled ?? true
    }
    : {
      url: fields.url ?? "",
      headers: { ...(fields.headers ?? {}) },
      autoApproveTools: [...(fields.autoApproveTools ?? [])],
      enabled: fields.enabled ?? true
    };

export class McpConfigStore {
  constructor(private readonly filePath: string = mcpConfigFilePath()) {}

  listAll(): readonly McpServerConfig[] {
    return [...readConfigMap(this.filePath).entries()]
      .map(([name, entry]) => entryToConfig(name, entry))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listEnabled(): readonly McpServerConfig[] {
    return this.listAll().filter((server) => server.enabled);
  }

  findById(id: string): McpServerConfig | undefined {
    return this.listAll().find((server) => server.id === id);
  }

  findByName(name: string): McpServerConfig | undefined {
    return this.findById(name);
  }

  create(fields: McpServerFields): McpServerConfig {
    return withConfig(this.filePath, (servers) => {
      const entry = fieldsToEntry(fields);
      servers.set(fields.name, entry);

      return entryToConfig(fields.name, entry);
    });
  }

  /** 全量替换一个条目。名字即身份:换了 name 就是删旧建新。 */
  update(id: string, fields: McpServerFields): McpServerConfig | undefined {
    return withConfig(this.filePath, (servers) => {
      if (!servers.has(id)) {
        return undefined;
      }

      servers.delete(id);

      const entry = fieldsToEntry(fields);
      servers.set(fields.name, entry);

      return entryToConfig(fields.name, entry);
    });
  }

  setEnabled(id: string, enabled: boolean): McpServerConfig | undefined {
    return withConfig(this.filePath, (servers) => {
      const entry = servers.get(id);

      if (!entry) {
        return undefined;
      }

      const next = { ...entry, enabled };
      servers.set(id, next);

      return entryToConfig(id, next);
    });
  }

  deleteById(id: string): boolean {
    return withConfig(this.filePath, (servers) => servers.delete(id));
  }

  /** 只读不写 —— 供启动迁移等一次性场景读原始条目。 */
  entries(): ReadonlyMap<string, McpEntry> {
    return readConfigMap(this.filePath);
  }
}
