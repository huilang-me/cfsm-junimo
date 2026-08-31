import { useQuery } from "@tanstack/react-query";
import { getConfig, mapConfigToMe } from "@/services/api";
import { CONFIG_QUERY_KEY } from "@/hooks/usePublicConfig";

export function useAuth() {
  return useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: ({ signal }) => getConfig({ signal }),
    select: mapConfigToMe,
    staleTime: 30_000,
    // 后台在新标签页登录后，返回时必须立即校验。
    refetchOnWindowFocus: "always",
  });
}
