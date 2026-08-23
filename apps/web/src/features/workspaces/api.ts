import { apiFetch } from "../../shared/api/fetch";
import type { Workspace, WorkspaceInput } from "../../types/api";

/** 从 ApiError 的 "HTTP 400: {json}" 里抠出服务端给的面向用户的 error 原文。 */
export const extractErrorText = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);

  const jsonStart = err.message.indexOf("{");
  if (jsonStart < 0) return err.message;

  try {
    const parsed = JSON.parse(err.message.slice(jsonStart)) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : err.message;
  } catch {
    return err.message;
  }
};

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