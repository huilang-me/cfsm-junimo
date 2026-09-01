import { useQuery } from "@tanstack/react-query";
import { getInstanceHistory, getLoadRecords } from "@/services/api";

const RECORD_QUERY_OPTIONS = {
  staleTime: Infinity,
  gcTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false,
} as const;

const INSTANCE_HISTORY_QUERY_OPTIONS = {
  staleTime: 0,
  gcTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: true,
  refetchOnMount: "always",
} as const;

export function useLoadRecords(uuid: string, hours = 6, enabled = true) {
  return useQuery({
    queryKey: ["records", "load", uuid, hours],
    queryFn: () => getLoadRecords(uuid, hours),
    ...RECORD_QUERY_OPTIONS,
    enabled: Boolean(uuid) && enabled,
  });
}

export function useInstanceHistory(uuid: string, hours = 6, enabled = true) {
  return useQuery({
    queryKey: ["records", "instance", "history-all-v3", uuid, hours],
    queryFn: () => getInstanceHistory(uuid, hours),
    ...INSTANCE_HISTORY_QUERY_OPTIONS,
    enabled: Boolean(uuid) && enabled,
  });
}
