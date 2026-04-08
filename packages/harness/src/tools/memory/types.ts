export type MemoryCategory =
  | "user"
  | "preference"
  | "project"
  | "decision"
  | "knowledge";

export type MemoryOrigin = "manual" | "tool_saved";

export interface MemoryEntry {
  readonly id: string;
  readonly category: MemoryCategory;
  readonly origin: MemoryOrigin;
  readonly content: string;
  readonly sourceSessionId: string | null;
  readonly sourceMessageId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Abstract memory store interface.
 * Harness defines the contract; server layer provides the implementation.
 */
export interface MemoryStore {
  save(content: string, category?: MemoryCategory, origin?: MemoryOrigin, sourceSessionId?: string, sourceMessageId?: string): Promise<MemoryEntry>;
  search(query: string, limit?: number): Promise<readonly MemoryEntry[]>;
  listAll(limit?: number): Promise<readonly MemoryEntry[]>;
  update(id: string, content: string, category?: MemoryCategory): Promise<MemoryEntry | undefined>;
  deleteById(id: string): Promise<boolean>;
}
