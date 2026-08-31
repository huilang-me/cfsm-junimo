import { useQuery } from "@tanstack/react-query";
import { getConfig, mapConfigToMe } from "@/services/api";
import { CONFIG_QUERY_KEY } from "@/hooks/usePublicConfig";

export function useAuth() {
  return useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: () => getConfig(),
    select: mapConfigToMe,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });
}
