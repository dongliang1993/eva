import { eq } from "drizzle-orm";

import type { AppDatabase } from "../index.js";
import { workspaces } from "../schema.js";
import type { Workspace } from "@eva/shared";

export interface CreateWorkspaceInput {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface IWorkspaceRepository {
  create(input: CreateWorkspaceInput): Workspace;
  findById(id: string): Workspace | undefined;
  findByPath(path: string): Workspace | undefined;
  listAll(): readonly Workspace[];
  rename(id: string, name: string): Workspace | undefined;
  deleteById(id: string): boolean;
}

export class DrizzleWorkspaceRepository implements IWorkspaceRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateWorkspaceInput): Workspace {
    this.db.insert(workspaces).values(input).run();
    return this.findById(input.id)!;
  }

  findById(id: string): Workspace | undefined {
    return this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  }

  findByPath(pathValue: string): Workspace | undefined {
    return this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.path, pathValue))
      .get();
  }

  listAll(): readonly Workspace[] {
    return this.db.select().from(workspaces).all();
  }

  rename(id: string, name: string): Workspace | undefined {
    this.db
      .update(workspaces)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(eq(workspaces.id, id))
      .run();

    return this.findById(id);
  }

  deleteById(id: string): boolean {
    const result = this.db.delete(workspaces).where(eq(workspaces.id, id)).run();
    return result.changes > 0;
  }
}