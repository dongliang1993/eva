import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initDb, migrateDb, closeDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import { DrizzleMessageRepository, DrizzleSessionRepository, SessionService } from "../../../apps/server/src/modules/sessions/index.js";
import { compactSession } from "../../../apps/server/src/modules/compact/index.js";
import { createUserUIMessage } from "../../../packages/shared/src/index.js";

let db: AppDatabase;
beforeEach(() => { db = initDb({ dbPath: ":memory:" }); migrateDb(db); });
afterEach(() => closeDb(db));

it("compaction only sees ancestors of the selected branch", async () => {
  const sessions = new DrizzleSessionRepository(db), messages = new DrizzleMessageRepository(db);
  sessions.create({ id: "s" });
  const add = (id: string, parentId?: string, parentToolCallId?: string) => messages.create({
    sessionId: "s", message: createUserUIMessage(id, id), depth: parentId ? 1 : 0,
    ...(parentId ? { parentId } : {}), ...(parentToolCallId ? { parentToolCallId } : {}),
  });
  add("root"); add("discarded", "root"); add("selected", "root");
  add("child-transcript", undefined, "tool-child");
  add("tail", "selected"); sessions.updateActiveLeaf("s", "tail");
  const summarize = vi.fn(async () => "selected summary");
  await compactSession(db, { sessionId: "s", keepRecentMessages: 1, summarize });
  expect(summarize.mock.calls[0][0].map((m: { id: string }) => m.id)).toEqual(["root", "selected"]);

  // The summary's anchor is not an ancestor of this version.
  const service = new SessionService(sessions, messages);
  const discarded = service.buildModelHistory(db, "s", "discarded");
  expect(discarded.summary).toBeUndefined();
  expect(discarded.messages.map(m => m.id)).toEqual(["root", "discarded"]);
});

it("history follows the leaf beyond 2000 messages", () => {
  const sessions = new DrizzleSessionRepository(db), messages = new DrizzleMessageRepository(db);
  sessions.create({ id: "long" });
  db.transaction(() => {
    for (let i = 0; i < 2002; i++) messages.create({
      sessionId: "long", message: createUserUIMessage(`m${i}`, `message ${i}`), depth: i,
      ...(i ? { parentId: `m${i - 1}` } : {}),
    });
    sessions.updateActiveLeaf("long", "m2001");
  });
  const history = new SessionService(sessions, messages).buildModelHistory(db, "long");
  expect(history.messages).toHaveLength(2002);
  expect(history.messages.at(-1)?.id).toBe("m2001");
});
