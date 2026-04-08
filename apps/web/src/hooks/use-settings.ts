import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "../api/fetch";
import type { AppSettings } from "../types/api";

const SETTINGS_KEY = ["settings"] as const;

export function useSettings() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => apiFetch<AppSettings>("/api/v1/settings")
  });

  const mutation = useMutation({
    mutationFn: (body: AppSettings) =>
      apiFetch<AppSettings>("/api/v1/settings", {
        method: "PUT",
        body: JSON.stringify(body)
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(SETTINGS_KEY, data);
    }
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    saveSettings: mutation.mutate,
    saveSettingsAsync: mutation.mutateAsync,
    isSaving: mutation.isPending,
    saveSuccess: mutation.isSuccess
  };
}
