import { useQuery } from "@tanstack/react-query";
import { getConfig, mapConfigToPublic } from "@/services/api";
import type { PublicConfig } from "@/types/cfsm";

export const CONFIG_QUERY_KEY = ["config"] as const;

export function usePublicConfig() {
  return useQuery<Record<string, unknown>, Error, PublicConfig>({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: ({ signal }) => getConfig({ signal }),
    select: mapConfigToPublic,
    staleTime: 60_000,
  });
}
