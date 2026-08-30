import { and, eq, inArray, notInArray } from "drizzle-orm";
import type {
  McpOrigin,
  McpServerConfig,
  McpTransport
} from "@eva/shared";

import type { AppDatabase } from "../../db/index.js";
import { mcpServers } from "../../db/schema.js";

/**
 * server 配置的服务端形状 —— **含密钥**（env / headers 的值）。
 * 出网关之前必须过 `toMcpServerConfig` 遮蔽。
 */
export interface McpServerRow {
  readonly id: string;
  readonly name: string;
  readonly origin: McpOrigin;
  readonly transport: McpTransport;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly url: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly autoApproveTools: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 一条 server 的可写字段（create / update / 文件同步共用）。 */
export interface McpServerFields {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly autoApproveTools?: readonly string[] | undefined;
  readonly enabled?: boolean | undefined;
}

export interface FileSyncResult {
  readonly synced: number;
  readonly removed: number;
  /** 与已有 manual 条目撞名而被跳过的名字 —— 手工配置优先，不静默覆盖用户的东西。 */
  readonly skippedNames: readonly string[];
}

/** 坏 JSON 不该让整个列表接口挂掉 —— 降级成空值并让上层照常工作。 */
const parseJsonArray = (raw: string): readonly string[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

const parseJsonRecord = (raw: string): Readonly<Record<string, string>> => {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  } catch {
    return {};
  }
};

const toRow = (row: typeof mcpServers.$inferSelect): McpServerRow => ({
  id: row.id,
  name: row.name,
  origin: row.origin,
  transport: row.transport,
  command: row.command,
  args: parseJsonArray(row.args),
  env: parseJsonRecord(row.env),
  url: row.url,
  headers: parseJsonRecord(row.headers),
  autoApproveTools: parseJsonArray(row.autoApproveTools),
  enabled: row.enabled,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

/** 行 → 对外配置：env / headers 只留 key 名（值是密钥）。 */
export const toMcpServerConfig = (row: McpServerRow): McpServerConfig => ({
  id: row.id,
  name: row.name,
  origin: row.origin,
  transport: row.transport,
  ...(row.command !== null ? { command: row.command } : {}),
  args: row.args,
  envKeys: Object.keys(row.env),
  ...(row.url !== null ? { url: row.url } : {}),
  headerKeys: Object.keys(row.headers),
  autoApproveTools: row.autoApproveTools,
  enabled: row.enabled,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

/** 可写字段 → DB 列值。只序列化传了的字段，未传的保持原值（update 语义）。 */
const toColumnValues = (fields: McpServerFields): Record<string, unknown> => ({
  name: fields.name,
  transport: fields.transport,
  command: fields.command ?? null,
  url: fields.url ?? null,
  ...(fields.args !== undefined ? { args: JSON.stringify(fields.args) } : {}),
  ...(fields.env !== undefined ? { env: JSON.stringify(fields.env) } : {}),
  ...(fields.headers !== undefined ? { headers: JSON.stringify(fields.headers) } : {}),
  ...(fields.autoApproveTools !== undefined
    ? { autoApproveTools: JSON.stringify(fields.autoApproveTools) }
    : {}),
  ...(fields.enabled !== undefined ? { enabled: fields.enabled } : {})
});

export class McpServerRepository {
  constructor(private readonly db: AppDatabase) {}

  listAll(): readonly McpServerRow[] {
    return this.db.select().from(mcpServers).all().map(toRow);
  }

  listEnabled(): readonly McpServerRow[] {
    return this.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true))
      .all()
      .map(toRow);
  }

  findById(id: string): McpServerRow | undefined {
    const row = this.db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
    return row ? toRow(row) : undefined;
  }

  findByName(name: string): McpServerRow | undefined {
    const row = this.db.select().from(mcpServers).where(eq(mcpServers.name, name)).get();
    return row ? toRow(row) : undefined;
  }

  create(id: string, origin: McpOrigin, fields: McpServerFields): McpServerRow {
    this.db
      .insert(mcpServers)
      .values({ id, origin, ...toColumnValues(fields) } as typeof mcpServers.$inferInsert)
      .run();

    return this.findById(id)!;
  }

  update(id: string, fields: McpServerFields): McpServerRow | undefined {
    this.db
      .update(mcpServers)
      .set({ ...toColumnValues(fields), updatedAt: new Date().toISOString() })
      .where(eq(mcpServers.id, id))
      .run();

    return this.findById(id);
  }

  /** 只改启停（file-origin 条目在 UI 里唯一允许的操作）。 */
  setEnabled(id: string, enabled: boolean): McpServerRow | undefined {
    this.db
      .update(mcpServers)
      .set({ enabled, updatedAt: new Date().toISOString() })
      .where(eq(mcpServers.id, id))
      .run();

    return this.findById(id);
  }

  deleteById(id: string): boolean {
    return this.db.delete(mcpServers).where(eq(mcpServers.id, id)).run().changes > 0;
  }

  /**
   * 把 mcp.json 的内容同步成 file-origin 行：文件里没有的 file 行删掉，有的按 name upsert。
   * manual 行完全不碰；与 manual 撞名的文件条目跳过（用户在 UI 里明确建过的东西优先）。
   *
   * 整个替换在一个事务里 —— 中途失败不留半套配置。
   */
  replaceFileOrigin(
    entries: readonly McpServerFields[],
    nextId: () => string
  ): FileSyncResult {
    return this.db.transaction((tx) => {
      const manualNames = new Set(
        tx
          .select({ name: mcpServers.name })
          .from(mcpServers)
          .where(eq(mcpServers.origin, "manual"))
          .all()
          .map((r) => r.name)
      );

      const skippedNames = entries.filter((e) => manualNames.has(e.name)).map((e) => e.name);
      const usable = entries.filter((e) => !manualNames.has(e.name));
      const keepNames = usable.map((e) => e.name);

      const removed = (
        keepNames.length > 0
          ? tx
            .delete(mcpServers)
            .where(and(eq(mcpServers.origin, "file"), notInArray(mcpServers.name, keepNames)))
            .run()
          : tx.delete(mcpServers).where(eq(mcpServers.origin, "file")).run()
      ).changes;

      const existing = new Map(
        (keepNames.length > 0
          ? tx.select().from(mcpServers).where(inArray(mcpServers.name, keepNames)).all()
          : []
        ).map((r) => [r.name, r])
      );

      for (const entry of usable) {
        const current = existing.get(entry.name);
        const values = toColumnValues(entry);

        if (current) {
          // 保留原 id：UI 与 registry 的状态都按 id 索引，换 id 会让状态"跳"一下
          tx.update(mcpServers)
            .set({ ...values, origin: "file", updatedAt: new Date().toISOString() })
            .where(eq(mcpServers.id, current.id))
            .run();
          continue;
        }

        tx.insert(mcpServers)
          .values({ id: nextId(), origin: "file", ...values } as typeof mcpServers.$inferInsert)
          .run();
      }

      return { synced: usable.length, removed, skippedNames };
    });
  }
}
