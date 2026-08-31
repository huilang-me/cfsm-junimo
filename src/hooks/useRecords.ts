import { useQuery } from "@tanstack/react-query";
import { getInstanceHistory, getLoadRecords, getPingRecords } from "@/services/api";

const RECORD_QUERY_OPTIONS = {
  staleTime: Infinity,
  gcTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false,
} as const;

export function useLoadRecords(uuid: string, hours = 6, enabled = true) {
  return useQuery({
    queryKey: ["records", "load", uuid, hours],
    queryFn: () => getLoadRecords(uuid, hours),
    ...RECORD_QUERY_OPTIONS,
    enabled: Boolean(uuid) && enabled,
  });
}

// stats 已并入 getPingRecords 的同一次请求(response.stats),不再单独发起查询。
export function usePingRecords(uuid: string, hours = 6, enabled = true) {
  return useQuery({
    queryKey: ["records", "ping", uuid, hours],
    queryFn: () => getPingRecords(uuid, hours),
    ...RECORD_QUERY_OPTIONS,
    enabled: Boolean(uuid) && enabled,
  });
}

export function useInstanceHistory(uuid: string, hours = 6, enabled = true) {
  return useQuery({
    queryKey: ["records", "instance", uuid, hours],
    queryFn: () => getInstanceHistory(uuid, hours),
    ...RECORD_QUERY_OPTIONS,
    enabled: Boolean(uuid) && enabled,
  });
}
