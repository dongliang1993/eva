import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "../api/fetch";
import type { ModelSummary } from "../types/api";

const MODELS_KEY = ["models"] as const;

export function useModels() {
  const query = useQuery({
    queryKey: MODELS_KEY,
    queryFn: () => apiFetch<readonly ModelSummary[]>("/api/v1/models")
  });

  return {
    data: query.data,
    isLoading: query.isLoading
  };
}
