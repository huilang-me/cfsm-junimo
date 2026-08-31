import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  retainHomeStore,
  retainNodeStore,
  getAllNodeMetaSnapshot,
  getHomeNodeSummariesSnapshot,
  getNodeMetaSnapshot,
  getNodeMetricsSnapshot,
  getNodeTrafficTrendSnapshot,
  getNodeOnlineSummariesSnapshot,
  getVisibleNodeUuidsSnapshot,
  subscribeHomeNodeSummaries,
  subscribeNodeOnlineSummaries,
  subscribeAllNodes,
  subscribeStoreStatus,
  subscribeVisibleNodeUuids,
  subscribeToNodeMeta,
  subscribeToNodeMetrics,
  subscribeToNodeTrafficTrend,
  getStoreStatusSnapshot,
  type HomeNodeSummary,
  type NodeOnlineSummary,
} from "@/services/wsStore";
import type { NodeInfo, NodeMetrics, TrafficTrendSample } from "@/types/cfsm";

const noopUnsubscribe = () => undefined;
type NodeStoreScope = "home" | "node";

function useEnsured(scope: NodeStoreScope, uuid: string, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    if (scope === "node") {
      if (uuid) return retainNodeStore(uuid);
      return;
    }
    return retainHomeStore();
  }, [enabled, scope, uuid]);
}

export function useNodeMeta(uuid: string, scope: NodeStoreScope = "home"): NodeInfo | undefined {
  useEnsured(scope, uuid, Boolean(uuid));
  return useNodeMetaSnapshot(uuid);
}

function useNodeMetaSnapshot(uuid: string): NodeInfo | undefined {
  const subscribe = useCallback(
    (callback: () => void) => subscribeToNodeMeta(uuid, callback),
    [uuid],
  );
  const getSnapshot = useCallback(() => getNodeMetaSnapshot(uuid), [uuid]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useNodeMetrics(
  uuid: string,
  enabled = true,
  scope: NodeStoreScope = "home",
): NodeMetrics | undefined {
  useEnsured(scope, uuid, enabled && Boolean(uuid));
  return useNodeMetricsSnapshot(uuid, enabled);
}

function useNodeMetricsSnapshot(uuid: string, enabled = true): NodeMetrics | undefined {
  const subscribe = useCallback(
    (callback: () => void) =>
      enabled ? subscribeToNodeMetrics(uuid, callback) : noopUnsubscribe,
    [uuid, enabled],
  );
  const getSnapshot = useCallback(
    () => (enabled ? getNodeMetricsSnapshot(uuid) : undefined),
    [uuid, enabled],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useNodeTrafficTrendSnapshot(
  uuid: string,
): { up: TrafficTrendSample[]; down: TrafficTrendSample[] } {
  const subscribe = useCallback(
    (callback: () => void) => subscribeToNodeTrafficTrend(uuid, callback),
    [uuid],
  );
  const getSnapshot = useCallback(() => getNodeTrafficTrendSnapshot(uuid), [uuid]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useNodeCardSnapshots(uuid: string) {
  useEnsured("home", uuid);
  return {
    meta: useNodeMetaSnapshot(uuid),
    metrics: useNodeMetricsSnapshot(uuid),
    trafficTrend: useNodeTrafficTrendSnapshot(uuid),
  };
}

export function useVisibleNodeUuids(includeHidden = false): string[] {
  useEnsured("home", "");
  const getSnapshot = useCallback(
    () => getVisibleNodeUuidsSnapshot(includeHidden),
    [includeHidden],
  );
  return useSyncExternalStore(
    subscribeVisibleNodeUuids,
    getSnapshot,
    getSnapshot,
  );
}

export function useAllNodeMeta(): NodeInfo[] {
  useEnsured("home", "");
  return useSyncExternalStore(
    subscribeAllNodes,
    getAllNodeMetaSnapshot,
    getAllNodeMetaSnapshot,
  );
}

export function useHomeNodeSummaries(): HomeNodeSummary[] {
  useEnsured("home", "");
  return useSyncExternalStore(
    subscribeHomeNodeSummaries,
    getHomeNodeSummariesSnapshot,
    getHomeNodeSummariesSnapshot,
  );
}

export function useNodeOnlineSummaries(): NodeOnlineSummary[] {
  useEnsured("home", "");
  return useSyncExternalStore(
    subscribeNodeOnlineSummaries,
    getNodeOnlineSummariesSnapshot,
    getNodeOnlineSummariesSnapshot,
  );
}

const EMPTY_STORE_STATUS = {
  failureStreak: 0,
  hydrated: false,
  nodeInfoError: false,
} as const;

export function useNodeStoreStatus(
  enabled = true,
  scope: NodeStoreScope = "home",
  uuid = "",
) {
  useEnsured(scope, uuid, enabled);
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? subscribeStoreStatus(listener) : noopUnsubscribe),
    [enabled],
  );
  const getSnapshot = useCallback(
    () => (enabled ? getStoreStatusSnapshot() : EMPTY_STORE_STATUS),
    [enabled],
  );
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
}
