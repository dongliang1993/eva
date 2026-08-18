import { apiFetch } from "../../shared/api/fetch";
import type { Workspace, WorkspaceInput } from "../../types/api";

export const listWorkspaces = async (): Promise<readonly Workspace[]> =>
  apiFetch<readonly Workspace[]>("/api/v1/workspaces");

export const createWorkspace = async (input: WorkspaceInput): Promise<Workspace> =>
  apiFetch<Workspace>("/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify(input)
  });

export const renameWorkspace = async (id: string, name: string): Promise<Workspace> =>
  apiFetch<Workspace>(`/api/v1/workspaces/${id}`, {
    method: "PUT",
    body: JSON.stringify({ name })
  });

export const deleteWorkspace = async (id: string): Promise<void> =>
  apiFetch<void>(`/api/v1/workspaces/${id}`, { method: "DELETE" });

export const setThreadWorkspace = async (
  threadId: string,
  workspaceId: string | null
): Promise<{ workspaceId: string | null }> =>
  apiFetch<{ workspaceId: string | null }>(`/api/v1/threads/${threadId}/workspace`, {
    method: "PUT",
    body: JSON.stringify({ workspaceId })
  });