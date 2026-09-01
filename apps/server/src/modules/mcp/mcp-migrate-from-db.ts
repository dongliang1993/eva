import type { AppDatabase } from "../../db/index.js";
import { McpConfigStore, type McpLogger } from "./mcp-config-store.js";

/**
 * 一次性迁移:旧 mcp_servers 表 → ~/.eva/mcp.json。
 *
 * 存储模型换成「文件即事实源」后,表里的条目(含 env/headers 的值 —— 表里一直是
 * 明文存的全量)得搬进文件,否则用户配好的 server 凭空消失。**必须跑在 migrateDb
 * 之前** —— 0034 迁移会删表,删了就没数据可搬;表已不存在时 SELECT 报错 →
 * 静默跳过,天然幂等。
 *
 * 0034 之后 schema.ts 里 mcp_servers 定义已删,这里用裸 SQL —— 迁移代码引用
 * 一个已删除的表定义,生命周期比表本身还长才是错的。
 */

interface LegacyRow {
  readonly name: string;
  readonly transport: string;
  readonly command: string | null;
  readonly args: string;
  readonly env: string;
  readonly url: string | null;
  readonly headers: string;
  readonly auto_approve_tools: string;
  readonly enabled: number;
}

/** 表还在吗:0034 之后 SELECT 会抛 "no such table",那是预期内的空转。 */
const readLegacyRows = (db: AppDatabase): readonly LegacyRow[] => {
  try {
    return db.all(
      "SELECT name, transport, command, args, env, url, headers, auto_approve_tools, enabled FROM mcp_servers"
    ) as readonly LegacyRow[];
  } catch {
    return [];
  }
};

export const migrateMcpServersToFile = (
  db: AppDatabase,
  logger: McpLogger,
  store: McpConfigStore = new McpConfigStore()
): void => {
  const rows = readLegacyRows(db);

  if (rows.length === 0) {
    return;
  }

  const existing = store.entries();

  let moved = 0;
  const skipped: string[] = [];

  for (const row of rows) {
    if (existing.has(row.name)) {
      skipped.push(row.name);
      continue;
    }

    let args: string[] = [];
    let env: Record<string, string> = {};
    let headers: Record<string, string> = {};
    let autoApproveTools: string[] = [];

    try {
      args = JSON.parse(row.args) as string[];
      env = JSON.parse(row.env) as Record<string, string>;
      headers = JSON.parse(row.headers) as Record<string, string>;
      autoApproveTools = JSON.parse(row.auto_approve_tools) as string[];
    } catch {
      // 单行 JSON 坏了不该让整个迁移停摆 —— 这一行按空值搬,至少 server 不丢
      logger.warn({ server: row.name }, "mcp_servers 行的 JSON 字段解析失败,按空值迁移");
    }

    const transport = row.transport === "http" ? "http" : "stdio";

    store.create({
      name: row.name,
      transport,
      ...(transport === "stdio"
        ? { command: row.command ?? "", args, env }
        : { url: row.url ?? "", headers }),
      autoApproveTools,
      enabled: row.enabled === 1
    });
    moved += 1;
  }

  if (moved > 0) {
    logger.info({ moved }, "mcp_servers 表条目已迁移进 ~/.eva/mcp.json");
  }

  if (skipped.length > 0) {
    logger.warn(
      { skipped },
      "mcp_servers 表里与 mcp.json 撞名的条目未迁移(文件优先);如需保留请手动合并"
    );
  }
};
