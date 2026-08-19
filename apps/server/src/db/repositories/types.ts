import type { EvaUIMessage } from "@eva/shared";

export interface Session {
  readonly id: string;
  readonly title: string;
  readonly model: string | null;
  readonly origin: string;
  readonly metadata: string;
  readonly workspaceId: string | null;
  /** 当前激活分支的叶子消息 id;老会话可能为 null(退化成时间序最后一条)。 */
  readonly activeLeafId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSessionInput {
  readonly id: string;
  readonly title?: string;
  readonly origin?: string;
  readonly workspaceId?: string;
}

// ---------------------------------------------------------------------------
// Message (UIMessage 整存)
// ---------------------------------------------------------------------------

export interface StoredMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly role: "user" | "assistant";
  readonly message: EvaUIMessage;
  readonly parentId: string | null;
  readonly slotId: string | null;
  readonly depth: number;
  readonly createdAt: string;
}

export interface CreateMessageInput {
  readonly sessionId: string;
  /** 行 id 与 role 都取自 `message` —— 不允许存在两份 id。 */
  readonly message: EvaUIMessage;
  readonly runId?: string;
  readonly parentId?: string;
  readonly slotId?: string;
  readonly depth?: number;
}

export interface GetMessagesOptions {
  readonly limit?: number;
}

export interface ISessionRepository {
  create(input: CreateSessionInput): Session;
  findById(id: string): Session | undefined;
  listAll(limit?: number): readonly Session[];
  updateTimestamp(id: string): void;
  updateTitle(id: string, title: string): void;
  updateModel(id: string, model: string): void;
  updateWorkspace(id: string, workspaceId: string | null): Session | undefined;
  /** 会话的激活分支叶子。允许悬空(id 可指向已删消息) —— 读路径已处理。 */
  updateActiveLeaf(id: string, messageId: string): void;
  deleteById(id: string): boolean;
}

export interface IMessageRepository {
  create(input: CreateMessageInput): StoredMessage;
  findBySessionId(
    sessionId: string,
    options?: GetMessagesOptions
  ): readonly StoredMessage[];
  findLastBySessionId(sessionId: string): StoredMessage | undefined;
  /** 按 id 取任意消息(不限制会话)。切版本/重生成要定位目标消息。 */
  findById(id: string): StoredMessage | undefined;
  deleteBySessionId(sessionId: string): number;
}

