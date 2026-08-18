import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "pino";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as sqliteVec from "sqlite-vec";

import type { AppConfig } from "../config.js";
import { evaDataDir } from "../paths.js";
import * as schema from "./schema.js";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

const DB_FILENAME = "eva.db";

const ensureDirectory = (dir: string): void => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

const configurePragmas = (sqlite: Database.Database): void => {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("cache_size = -64000");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("temp_store = MEMORY");
};

export interface InitDbOptions {
  readonly dbPath?: string;
}

export const getDefaultDbPath = (): string =>
  path.join(evaDataDir(), DB_FILENAME);

let vecLoaded = false;

export const isVecAvailable = (): boolean => vecLoaded;

const loadVecExtension = (sqlite: Database.Database): void => {
  try {
    sqliteVec.load(sqlite);
    vecLoaded = true;
  } catch {
    vecLoaded = false;
  }
};

/** Embedding dimension — must match the model used (BGE-M3 = 1024). */
export const EMBEDDING_DIMENSIONS = 1024;

const VEC_TABLE = "memory_embeddings";

/** 读现有 vec0 表声明的维度;表不存在返回 undefined。 */
const readVecTableDimensions = (sqlite: Database.Database): number | undefined => {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(VEC_TABLE) as { sql?: string } | undefined;
  const matched = row?.sql?.match(/FLOAT\[(\d+)\]/i)?.[1];

  return matched ? Number(matched) : undefined;
};

/**
 * vec0 虚表是派生索引,但**重建代价是重新调用 embedding API**,不能每次启动都清。
 * 只在「不存在」或「维度变了」时重建;后者同时把 ready 打回 pending,
 * 否则 backfillPendingEmbeddings 永远捞不到它们(它只看 pending/error)。
 */
const createVecTables = (sqlite: Database.Database): void => {
  if (!vecLoaded) {
    return;
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memory_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const existingDimensions = readVecTableDimensions(sqlite);

  if (existingDimensions === EMBEDDING_DIMENSIONS) {
    return;
  }

  sqlite.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
  sqlite.exec(`
    CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding FLOAT[${EMBEDDING_DIMENSIONS}]
    );
  `);

  if (existingDimensions !== undefined) {
    // 维度变更 → 旧向量全部作废,标回 pending 让 backfill 重建
    sqlite.exec("UPDATE memories SET embedding_status = 'pending' WHERE embedding_status = 'ready'");
  }
};

export const initDb = (options: InitDbOptions = {}): AppDatabase => {
  const dbPath = options.dbPath ?? getDefaultDbPath();

  ensureDirectory(path.dirname(dbPath));

  const sqlite = new Database(dbPath);
  configurePragmas(sqlite);
  loadVecExtension(sqlite);

  const db = drizzle(sqlite, { schema });

  return db;
};

const resolveMigrationsFolder = (): string => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(currentDir, "migrations"),
    path.resolve(currentDir, "../src/db/migrations")
  ];
  const resolved = candidates.find((candidate) =>
    existsSync(path.join(candidate, "meta", "_journal.json"))
  );

  if (!resolved) {
    throw new Error(`Can't find migrations folder. Checked: ${candidates.join(", ")}`);
  }

  return resolved;
};

export const migrateDb = (db: AppDatabase): void => {
  const migrationsFolder = resolveMigrationsFolder();

  migrate(db, { migrationsFolder });

  // Create vec0 virtual tables after standard migrations (requires extension)
  const sqlite = (db as unknown as { $client: Database.Database }).$client;
  createVecTables(sqlite);
};

export const closeDb = (db: AppDatabase): void => {
  const sqlite = (db as unknown as { $client: Database.Database }).$client;

  try {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // Ignore checkpoint failures during shutdown for read-only or transient DBs.
  }

  sqlite.close();
};

/**
 * Open the database at the configured path (or the default path) and run
 * migrations. Returns a db ready for use. Migration failures propagate —
 * a startup with a bad schema should crash the process.
 */
export const initializeDatabase = (
  config: AppConfig,
  logger: Logger
): AppDatabase => {
  const dbPath = config.DB_PATH || getDefaultDbPath();
  const db = initDb({ dbPath });
  migrateDb(db);
  logger.info({ dbPath }, "database initialized");
  return db;
};

export { schema };
