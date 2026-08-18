import type { EvaUIMessage } from "@eva/shared";

export interface Session {
  readonly id: string;
  readonly title: string;
  readonly model: string | null;
  readonly origin: string;
  readonly metadata: string;
  readonly workspaceId: string | null;
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
  deleteById(id: string): boolean;
}

export interface IMessageRepository {
  create(input: CreateMessageInput): StoredMessage;
  findBySessionId(
    sessionId: string,
    options?: GetMessagesOptions
  ): readonly StoredMessage[];
  findLastBySessionId(sessionId: string): StoredMessage | undefined;
  deleteBySessionId(sessionId: string): number;
}

