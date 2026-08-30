import type { Workspace } from "@eva/shared";

import type { WorkspaceStore } from "./workspace-store.js";

export interface WorkspacesApi {
  list(): readonly Workspace[];
  /** 路径不可用时抛 UnusableWorkspacePathError —— 消息面向用户,由调用方映射成 400。 */
  add(input: { readonly path: string; readonly name?: string }): Workspace;
  rename(id: string, name: string): Workspace | undefined;
  remove(id: string): boolean;
}

export const createWorkspacesApi = (deps: {
  readonly workspaces: WorkspaceStore;
}): WorkspacesApi => ({
  list: () => deps.workspaces.list(),
  add: (input) => deps.workspaces.add(input),
  rename: (id, name) => deps.workspaces.rename(id, name),
  remove: (id) => deps.workspaces.remove(id)
});
