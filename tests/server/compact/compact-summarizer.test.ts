import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, initDb, migrateDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import { DrizzleMessageRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { SessionCompactionRepository } from "../../../apps/server/src/modules/compact/index.js";
import { compactSession } from "../../../apps/server/src/modules/compact/index.js";
import type { SummarizeMessages } from "../../../apps/server/src/modules/compact/index.js";
import { createUserUIMessage } from "../../../packages/shared/src/index.js";

let db: AppDatabase;

beforeEach(() => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
});

afterEach(() => {
  closeDb(db);
});

/** 建一个会话 + N 条 user 消息(足够触发 compactMessageCount)。 */
const seedSessionWithMessages = (sessionId: string, count: number): void => {
  const sessionRepo = new DrizzleSessionRepository(db);
  sessionRepo.create({ id: sessionId });
  const messageRepo = new DrizzleMessageRepository(db);
  for (let i = 0; i < count; i += 1) {
    messageRepo.create({
      sessionId,
      message: createUserUIMessage(randomUUID(), `message ${i}`)
    });
  }
};

describe("compactSession 注入 summarizer", () => {
  it("注入返回固定文本的 summarize → 落库的就是它", async () => {
    seedSessionWithMessages("s-1", 20);

    const summarize: SummarizeMessages = async () => "LLM 摘要:固定文本";
    await compactSession(db, { sessionId: "s-1", trigger: "manual", summarize });

    const stored = new SessionCompactionRepository(db).findBySessionId("s-1");
    expect(stored?.summary).toBe("LLM 摘要:固定文本");
  });

  it("注入抛错的 summarize → 回落确定性拼接(不抛出)", async () => {
    seedSessionWithMessages("s-2", 20);

    const summarize: SummarizeMessages = async () => {
      throw new Error("LLM 挂了");
    };
    const result = await compactSession(db, { sessionId: "s-2", trigger: "manual", summarize });
    expect(result.compacted).toBe(true);

    const stored = new SessionCompactionRepository(db).findBySessionId("s-2");
    expect(stored?.summary).toContain("Conversation summary");
  });

  it("注入返回空串的 summarize → 也回落", async () => {
    seedSessionWithMessages("s-3", 20);

    const summarize: SummarizeMessages = async () => "   ";
    await compactSession(db, { sessionId: "s-3", trigger: "manual", summarize });

    const stored = new SessionCompactionRepository(db).findBySessionId("s-3");
    expect(stored?.summary).toContain("Conversation summary");
  });
});