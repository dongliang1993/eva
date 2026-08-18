import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { WorkspaceInput } from "../../../types/api";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  renameWorkspace
} from "../api";

const WORKSPACES_KEY = ["workspaces"] as const;

export function useWorkspaces() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: listWorkspaces
  });

  const add = useMutation({
    mutationFn: (input: WorkspaceInput) => createWorkspace(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY })
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameWorkspace(id, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY })
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteWorkspace(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY })
  });

  return {
    workspaces: query.data ?? [],
    isLoading: query.isLoading,
    add,
    rename,
    remove
  };
}