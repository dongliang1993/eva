import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "pino";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

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

export const initDb = (options: InitDbOptions = {}): AppDatabase => {
  const dbPath = options.dbPath ?? getDefaultDbPath();

  ensureDirectory(path.dirname(dbPath));

  const sqlite = new Database(dbPath);
  configurePragmas(sqlite);

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
