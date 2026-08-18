import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "../../../shared/api/fetch";
import type {
  McpServerConfig,
  McpServerInput,
  McpServerStatus,
  McpServersPayload
} from "../../../types/api";

const MCP_KEY = ["mcp-servers"] as const;

interface UpdateInput {
  readonly id: string;
  /** file-origin 条目只能传 { enabled }；manual 传完整配置。 */
  readonly body: McpServerInput | { readonly enabled: boolean };
}

export function useMcpServers() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: MCP_KEY,
    queryFn: () => apiFetch<McpServersPayload>("/api/v1/mcp-servers")
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: MCP_KEY });

  const addMutation = useMutation({
    mutationFn: (body: McpServerInput) =>
      apiFetch<McpServerConfig>("/api/v1/mcp-servers", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    onSuccess: invalidate
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: UpdateInput) =>
      apiFetch<McpServerConfig>(`/api/v1/mcp-servers/${id}`, {
        method: "PUT",
        body: JSON.stringify(body)
      }),
    onSuccess: invalidate
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/mcp-servers/${id}`, { method: "DELETE" }),
    onSuccess: invalidate
  });

  const reconnectMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<McpServerStatus>(`/api/v1/mcp-servers/${id}/reconnect`, {
        method: "POST"
      }),
    onSuccess: invalidate
  });

  return {
    servers: query.data?.servers ?? [],
    statuses: query.data?.statuses ?? [],
    isLoading: query.isLoading,
    addServerAsync: addMutation.mutateAsync,
    updateServerAsync: updateMutation.mutateAsync,
    removeServerAsync: removeMutation.mutateAsync,
    reconnectAsync: reconnectMutation.mutateAsync,
    isMutating:
      addMutation.isPending
      || updateMutation.isPending
      || removeMutation.isPending
      || reconnectMutation.isPending
  };
}
