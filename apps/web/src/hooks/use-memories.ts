import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "../api/fetch";
import type { MemoryCategory, MemoryRecord, MemoryStats } from "../types/api";

interface UpdateMemoryInput {
  readonly id: string;
  readonly content: string;
  readonly category?: MemoryCategory;
}

const MEMORIES_KEY = ["memories"] as const;
const MEMORY_STATS_KEY = ["memories", "stats"] as const;

const buildSearchKey = (query: string) =>
  [...MEMORIES_KEY, "search", query] as const;

const invalidateMemoryQueries = async (
  queryClient: ReturnType<typeof useQueryClient>
): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: MEMORIES_KEY });
};

export function useMemories(searchQuery: string) {
  const queryClient = useQueryClient();
  const trimmedQuery = searchQuery.trim();

  const listQuery = useQuery({
    queryKey: MEMORIES_KEY,
    queryFn: () => apiFetch<readonly MemoryRecord[]>("/api/v1/memories")
  });

  const searchResultsQuery = useQuery({
    queryKey: buildSearchKey(trimmedQuery),
    queryFn: () =>
      apiFetch<readonly MemoryRecord[]>("/api/v1/memories/search", {
        method: "POST",
        body: JSON.stringify({ query: trimmedQuery })
      }),
    enabled: trimmedQuery.length > 0
  });

  const createMutation = useMutation({
    mutationFn: ({ content, category }: { content: string; category?: MemoryCategory }) =>
      apiFetch<MemoryRecord>("/api/v1/memories", {
        method: "POST",
        body: JSON.stringify({ content, ...(category ? { category } : {}) })
      }),
    onSuccess: async () => {
      await invalidateMemoryQueries(queryClient);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, content, category }: UpdateMemoryInput) =>
      apiFetch<MemoryRecord>(`/api/v1/memories/${id}`, {
        method: "PUT",
        body: JSON.stringify({ content, ...(category ? { category } : {}) })
      }),
    onSuccess: async () => {
      await invalidateMemoryQueries(queryClient);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/memories/${id}`, {
        method: "DELETE"
      }),
    onSuccess: async () => {
      await invalidateMemoryQueries(queryClient);
    }
  });

  const activeQuery = trimmedQuery.length > 0 ? searchResultsQuery : listQuery;
  const memories = trimmedQuery.length > 0
    ? searchResultsQuery.data ?? []
    : listQuery.data ?? [];

  return {
    memories,
    totalCount: listQuery.data?.length ?? 0,
    visibleCount: memories.length,
    isLoading: activeQuery.isLoading,
    isFetching: activeQuery.isFetching,
    error: activeQuery.error,
    createMemory: createMutation.mutateAsync,
    updateMemory: updateMutation.mutateAsync,
    deleteMemory: deleteMutation.mutateAsync,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending
  };
}

export function useMemoryStats() {
  return useQuery({
    queryKey: MEMORY_STATS_KEY,
    queryFn: () => apiFetch<MemoryStats>("/api/v1/memories/stats")
  });
}

export type { MemoryCategory, MemoryRecord };
