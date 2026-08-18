import { randomUUID } from "node:crypto";
import type { EvaUIMessage } from "@eva/shared";
import { uiMessageText } from "@eva/shared";

import type { AppDatabase } from "../db/index.js";
import { SessionCompactionRepository } from "../db/repositories/session-compaction-repository.js";
import type {
  IMessageRepository,
  ISessionRepository,
  Session,
  StoredMessage
} from "../db/repositories/types.js";

/** 会话历史的最大条数 —— 超过这个量必然已经 compact 过。 */
const HISTORY_LIMIT = 2000;

/** 会话标题取用户首句的前 N 字。 */
const TITLE_LENGTH = 50;

export interface ModelHistory {
  /** compaction 摘要;存在时由调用方作为一条 system ModelMessage 前置。 */
  readonly summary?: string;
  readonly messages: readonly EvaUIMessage[];
}

export interface ResolvedSession {
  readonly session: Session;
  readonly userMessage: StoredMessage;
  readonly isNew: boolean;
}

export class SessionService {
  constructor(
    private readonly sessions: ISessionRepository,
    private readonly messages: IMessageRepository
  ) {}

  createSession(input: EvaUIMessage, runId?: string): ResolvedSession {
    const session = this.sessions.create({
      id: randomUUID(),
      title: uiMessageText(input).slice(0, TITLE_LENGTH)
    });

    return {
      session,
      userMessage: this.appendUserMessage(session.id, input, runId),
      isNew: true
    };
  }

  continueSession(
    sessionId: string,
    userMessage: EvaUIMessage,
    runId?: string
  ): ResolvedSession | undefined {
    const session = this.sessions.findById(sessionId);

    if (!session) {
      return undefined;
    }

    return {
      session,
      userMessage: this.appendUserMessage(session.id, userMessage, runId),
      isNew: false
    };
  }

  /**
   * 模型可见的历史。有 compaction 时返回 [摘要, ...保留的尾部],
   * 否则返回全量。永远不删库里的消息。
   */
  buildModelHistory(db: AppDatabase, sessionId: string): ModelHistory {
    const all = this.messages.findBySessionId(sessionId, { limit: HISTORY_LIMIT });
    const compaction = new SessionCompactionRepository(db).findBySessionId(sessionId);

    if (!compaction) {
      return { messages: all.map((m) => m.message) };
    }

    const coveredIdx = all.findIndex((m) => m.id === compaction.coveredUntilMessageId);
    const tail = coveredIdx >= 0
      ? all.slice(coveredIdx + 1)
      : all.slice(-compaction.preservedTailMessageCount);

    return {
      summary: compaction.summary,
      messages: tail.map((m) => m.message)
    };
  }

  recordAssistantMessage(
    sessionId: string,
    message: EvaUIMessage,
    runId?: string
  ): StoredMessage {
    const stored = this.append(sessionId, message, runId);
    this.sessions.updateTimestamp(sessionId);

    return stored;
  }

  private appendUserMessage(
    sessionId: string,
    message: EvaUIMessage,
    runId?: string
  ): StoredMessage {
    const stored = this.append(sessionId, message, runId);
    this.sessions.updateTimestamp(sessionId);

    return stored;
  }

  /** 线性链写入版本树三件套:parent = 上一条,depth = 上一条 + 1。 */
  private append(
    sessionId: string,
    message: EvaUIMessage,
    runId?: string
  ): StoredMessage {
    const previous = this.messages.findLastBySessionId(sessionId);

    return this.messages.create({
      sessionId,
      message,
      slotId: randomUUID(),
      depth: previous ? previous.depth + 1 : 0,
      ...(runId !== undefined ? { runId } : {}),
      ...(previous ? { parentId: previous.id } : {})
    });
  }
}