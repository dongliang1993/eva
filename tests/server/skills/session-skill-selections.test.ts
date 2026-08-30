import { afterEach, describe, expect, it } from "vitest";

import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/db/repositories/session-repository.js";
import { DrizzleSessionSkillSelectionRepository } from "../../../apps/server/src/db/repositories/session-skill-selection-repository.js";

let db: AppDatabase | undefined;

afterEach(() => {
  if (db) closeDb(db);
  db = undefined;
});

const setup = () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
  new DrizzleSessionRepository(db).create({ id: "s1", title: "test" });
  return new DrizzleSessionSkillSelectionRepository(db);
};

describe("DrizzleSessionSkillSelectionRepository", () => {
  it("upserts idempotently and lists by session", () => {
    const repo = setup();

    repo.upsertMany("s1", ["alpha", "beta", "alpha"]);
    repo.upsertMany("s1", ["alpha"]);

    expect(repo.listBySession("s1").map((row) => row.skillName)).toEqual([
      "alpha",
      "beta"
    ]);
    expect(repo.listBySession("s1")[0]?.origin).toBe("auto");
  });

  it("deleteBySession removes rows and session cascade removes selections", () => {
    const repo = setup();
    repo.upsertMany("s1", ["alpha"]);
    expect(repo.deleteBySession("s1")).toBe(1);
    expect(repo.listBySession("s1")).toEqual([]);

    repo.upsertMany("s1", ["beta"]);
    new DrizzleSessionRepository(db!).deleteById("s1");
    expect(repo.listBySession("s1")).toEqual([]);
  });
});
