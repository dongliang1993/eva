import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { AppDatabase } from "../../db/index.js";
import {
  McpServerRepository,
  type FileSyncResult,
  type McpServerFields
} from "../../db/repositories/mcp-server-repository.js";
import { evaDataDir } from "../../paths.js";
import { MCP_SERVER_NAME_PATTERN } from "./mcp-tools.js";

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

export interface McpConfigSyncResult extends FileSyncResult {
  /** 名字不合法而被跳过的条目。 */
  readonly invalidNames: readonly string[];
}

const EMPTY_RESULT: McpConfigSyncResult = {
  synced: 0,
  removed: 0,
  skippedNames: [],
  invalidNames: []
};

/** 默认配置文件位置（与 DB、tool-overflow 同一个用户数据根）。 */
export const mcpConfigFilePath = (): string => path.join(evaDataDir(), "mcp.json");

const toFields = (
  name: string,
  entry: z.infer<typeof entrySchema>
): McpServerFields =>
  "command" in entry
    ? {
      name,
      transport: "stdio",
      command: entry.command,
      args: entry.args,
      env: entry.env,
      autoApproveTools: entry.autoApproveTools,
      enabled: entry.enabled
    }
    : {
      name,
      transport: "http",
      url: entry.url,
      headers: entry.headers,
      autoApproveTools: entry.autoApproveTools,
      enabled: entry.enabled
    };

/**
 * 把 `~/.eva/mcp.json` 同步成 `mcp_servers` 表里的 file-origin 行。
 *
 * 运行时只读表、不读文件 —— 文件是导入通道（`docs/plans/r2/T9-mcp.md` §2.1）。
 * 文件不存在是常态（多数用户不用它）；解析失败只记日志**不抛**：一份坏掉的
 * 可选配置文件不该让服务起不来。
 */
export const syncMcpConfigFile = (
  db: AppDatabase,
  logger: McpLogger,
  filePath: string = mcpConfigFilePath()
): McpConfigSyncResult => {
  if (!existsSync(filePath)) {
    return EMPTY_RESULT;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    logger.error({ err: error, filePath }, "mcp.json 不是合法 JSON，已忽略");
    return EMPTY_RESULT;
  }

  const validated = configFileSchema.safeParse(parsed);

  if (!validated.success) {
    logger.error(
      { filePath, issues: validated.error.issues },
      "mcp.json 结构不合法，已忽略"
    );
    return EMPTY_RESULT;
  }

  const invalidNames: string[] = [];
  const entries: McpServerFields[] = [];

  for (const [name, entry] of Object.entries(validated.data.mcpServers)) {
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      invalidNames.push(name);
      continue;
    }

    entries.push(toFields(name, entry));
  }

  if (invalidNames.length > 0) {
    logger.warn(
      { filePath, invalidNames },
      "mcp.json 里有名字不合法的 server（只允许小写字母、数字、_ 和 -），已跳过"
    );
  }

  const synced = new McpServerRepository(db).replaceFileOrigin(entries, randomUUID);

  if (synced.skippedNames.length > 0) {
    logger.warn(
      { filePath, skippedNames: synced.skippedNames },
      "mcp.json 里的 server 与手工创建的同名，已跳过（手工配置优先，改名或删掉 UI 里的那条）"
    );
  }

  if (synced.synced > 0 || synced.removed > 0) {
    logger.info(
      { filePath, synced: synced.synced, removed: synced.removed },
      "mcp.json 已同步"
    );
  }

  return { ...synced, invalidNames };
};
