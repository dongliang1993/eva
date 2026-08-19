import { randomUUID } from "node:crypto";
import type { EvaUIMessage } from "@eva/shared";
import { uiMessageText } from "@eva/shared";

import type { AppDatabase } from "../db/index.js";
import { SessionCompactionRepository } from "../db/repositories/session-compaction-repository.js";
import { buildActiveChain } from "./message-tree.js";
import type {
  IMessageRepository,
  ISessionRepository,
  Session,
  StoredMessage
} from "../db/repositories/types.js";

/** 一条消息在树里的位置。 */
export interface MessagePosition {
  readonly parentId: string | null;
  readonly slotId: string;
  readonly depth: number;
}

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
  ) { }

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
   * 模型可见历史。只包含激活链上的消息(切版本后旧分支不可见)。
   * @param leafId 从哪条回溯;缺省用 session.activeLeafId;retry 模式传
   *   "被重试消息的父",这样历史里不含被重试的那条回复本身。
   */
  buildModelHistory(
    db: AppDatabase,
    sessionId: string,
    leafId?: string
  ): ModelHistory {
    const all = this.messages.findBySessionId(sessionId, { limit: HISTORY_LIMIT });
    const session = this.sessions.findById(sessionId);
    const activeLeaf = leafId ?? session?.activeLeafId ?? null;
    const chain = buildActiveChain(all, activeLeaf);

    if (chain.length === 0) {
      // activeLeaf 指向不存在的 id → 空会话语义(不抛,调用方拿到空列表)。
      return { messages: [] };
    }

    const compaction = new SessionCompactionRepository(db).findBySessionId(sessionId);

    if (!compaction) {
      return { messages: chain.map((m) => m.message) };
    }

    const coveredIdx = chain.findIndex((m) => m.id === compaction.coveredUntilMessageId);
    const tail = coveredIdx >= 0
      ? chain.slice(coveredIdx + 1)
      : chain.slice(-compaction.preservedTailMessageCount);

    return {
      summary: compaction.summary,
      messages: tail.map((m) => m.message)
    };
  }

  /**
   * 落库一条 assistant 消息,位置由调用方给定(openSessionTurn 阶段算好)。
   * send 模式 = positionAfterActiveLeaf;retry 模式 = positionAlongside(被重试消息)。
   */
  recordAssistantMessage(
    sessionId: string,
    message: EvaUIMessage,
    position: MessagePosition,
    runId?: string
  ): StoredMessage {
    const stored = this.append(sessionId, message, position, runId);
    this.sessions.updateTimestamp(sessionId);

    return stored;
  }

  private appendUserMessage(
    sessionId: string,
    message: EvaUIMessage,
    runId?: string
  ): StoredMessage {
    const position = this.positionAfterActiveLeaf(sessionId);
    const stored = this.append(sessionId, message, position, runId);
    this.sessions.updateTimestamp(sessionId);

    return stored;
  }

  /**
   * 新消息的位置:parent = activeLeaf 指向的消息,slot = 新 UUID。
   * 公开给 runs.ts 的 retry 分支复用(send 用 positionAfterActiveLeaf)。
   */
  positionAlongside(target: StoredMessage): MessagePosition {
    return {
      parentId: target.parentId,
      slotId: target.slotId ?? randomUUID(),
      depth: target.depth
    };
  }

  /**
   * 新消息挂在哪:parent = activeLeaf 指向的消息(拿不到就退化最后一条),slot = 新 UUID。
   * 公开给 runs.ts 的 send 分支在阶段①就算好 assistant 落点。
   */
  positionAfterActiveLeaf(sessionId: string): MessagePosition {
    const session = this.sessions.findById(sessionId);
    let parent: StoredMessage | undefined;

    if (session?.activeLeafId !== null && session?.activeLeafId !== undefined) {
      const leaf = this.messages.findBySessionId(sessionId, { limit: HISTORY_LIMIT })
        .find((m) => m.id === session.activeLeafId);
      if (leaf) parent = leaf;
    }

    if (!parent) {
      // 老会话(activeLeafId 为空)或叶子已被删 → 退化时间序最后一条。
      parent = this.messages.findLastBySessionId(sessionId);
    }

    return {
      parentId: parent ? parent.id : null,
      slotId: randomUUID(),
      depth: parent ? parent.depth + 1 : 0
    };
  }

  /**
   * 落库核心:用给定位置写入版本树三件套,并总是更新 activeLeaf 指向新消息。
   */
  private append(
    sessionId: string,
    message: EvaUIMessage,
    position: MessagePosition,
    runId?: string
  ): StoredMessage {
    const stored = this.messages.create({
      sessionId,
      message,
      slotId: position.slotId,
      depth: position.depth,
      ...(position.parentId !== null ? { parentId: position.parentId } : {}),
      ...(runId !== undefined ? { runId } : {})
    });

    this.sessions.updateActiveLeaf(sessionId, stored.id);

    return stored;
  }
}