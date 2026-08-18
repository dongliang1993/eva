import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "../../../shared/api/fetch";
import type {
  Provider,
  ProviderConnectionTestResult,
  ProviderModelsPayload
} from "../../../types/api";

const PROVIDERS_KEY = ["providers"] as const;
const MODELS_KEY = ["models"] as const;

interface UpdateProviderInput {
  readonly id: string;
  readonly body: Record<string, unknown>;
}

interface ProviderRuntimeInput {
  readonly id: string;
  readonly body?: Record<string, unknown>;
}

export function useProviders() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => apiFetch<readonly Provider[]>("/api/v1/providers")
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: UpdateProviderInput) =>
      apiFetch<Provider>(`/api/v1/providers/${id}`, {
        method: "PUT",
        body: JSON.stringify(body)
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY }),
        queryClient.invalidateQueries({ queryKey: MODELS_KEY })
      ]);
    }
  });

  const testMutation = useMutation({
    mutationFn: ({ id, body }: ProviderRuntimeInput) =>
      apiFetch<ProviderConnectionTestResult>(`/api/v1/providers/${id}/test`, {
        method: "POST",
        body: JSON.stringify(body ?? {})
      })
  });

  const fetchModelsMutation = useMutation({
    mutationFn: ({ id, body }: ProviderRuntimeInput) =>
      apiFetch<ProviderModelsPayload>(`/api/v1/providers/${id}/models/fetch`, {
        method: "POST",
        body: JSON.stringify(body ?? {})
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
    }
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    updateProvider: updateMutation.mutate,
    updateProviderAsync: updateMutation.mutateAsync,
    testProviderAsync: testMutation.mutateAsync,
    fetchProviderModelsAsync: fetchModelsMutation.mutateAsync,
    isSaving: updateMutation.isPending,
    saveSuccess: updateMutation.isSuccess
  };
}
