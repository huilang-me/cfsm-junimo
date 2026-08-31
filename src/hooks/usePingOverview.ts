import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useMinuteClock } from "@/hooks/useClock";
import { useVisibleNodeUuids } from "@/hooks/useNode";
import { useHiddenNodeUuids } from "@/hooks/useVisibleNodes";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import {
  getPingOverview,
  prewarmPingOverviewDependencies,
} from "@/services/api";
import type {
  HomepagePingLine,
  PingOverviewBucket,
  PingOverviewItem,
  PingOverviewTaskLoadState,
  PingRecord,
  PingTaskStats,
} from "@/types/cfsm";
import { withTimeoutSignal } from "@/utils/abort";
import { getCfsmProbeName } from "@/utils/cfsmProbeMetrics";
import { resolvePingSampleCounts } from "@/utils/pingMetrics";
import {
  hasUsableHomepageMultiPingGroups,
  HOMEPAGE_MULTI_PING_TASK_COUNT,
  resolveHomepagePingSelections,
  type HomepageMultiPingGroup,
  type HomepagePingTaskBindings,
} from "@/utils/pingTasks";
import type { NodeViewMode } from "@/utils/themeSettings";

const DEFAULT_PING_REFRESH_INTERVAL = 60_000;
const MIN_PING_REFRESH_INTERVAL = 10_000;
const MAX_PING_REFRESH_INTERVAL = 300_000;
// 首页延迟图表最多显示 24 个 bucket。metric API 返回的是聚合区间而不是瞬时点，
// 绘制时要把较粗的后端区间投影到它覆盖的可视 bucket，同时保持卡片密度一致。
const MAX_VISIBLE_HOMEPAGE_PING_BUCKETS = 24;

const EMPTY_PING: PingOverviewItem = {
  client: "",
  isAssigned: false,
  loadState: "pending",
  lastValue: null,
  samples: [],
  max: 1,
  loss: null,
};
const EMPTY_PING_LINES: HomepagePingLine[] = [];
const EMPTY_PING_BUCKETS: PingOverviewBucket[] = [];
const EMPTY_TASK_IDS: number[] = [];
const EMPTY_BINDINGS: HomepagePingTaskBindings = {};
const EMPTY_MULTI_PING_GROUPS: HomepageMultiPingGroup[] = [];
const CFSM_HOMEPAGE_MULTI_PING_TASK_IDS = [1, 2, 3];

type HomepagePingRequestMode = "single" | "multi";

export function resolveHomepagePingRequestMode(
  viewMode: NodeViewMode,
  multiPingEnabled: boolean,
  multiTaskIds: number[],
  multiGroups: HomepageMultiPingGroup[] = [],
): HomepagePingRequestMode {
  return (viewMode === "large" || viewMode === "compact") &&
    multiPingEnabled &&
    (multiTaskIds.length === HOMEPAGE_MULTI_PING_TASK_COUNT ||
      hasUsableHomepageMultiPingGroups(multiGroups))
    ? "multi"
    : "single";
}

export interface PingOverviewMapResult {
  assignmentKey: string;
  intervalMs: number;
  singleItems: Map<string, PingOverviewItem>;
  multiLines: Map<string, HomepagePingLine[]>;
  successfulTaskIds: number[];
  failedTaskIds: number[];
  pendingTaskIds: number[];
  /** 进度提交时仅包含本次被任务状态/数据更新影响的节点。 */
  changedUuids?: string[];
}

export type PingOverviewLoadState = "idle" | "loading" | "ready" | "error";

export interface PingOverviewStatusSnapshot {
  status: PingOverviewLoadState;
  isRefreshing: boolean;
}

const EMPTY_PING_STATUS: PingOverviewStatusSnapshot = {
  status: "idle",
  isRefreshing: false,
};

type Listener = () => void;

function toTimestamp(value: string | number) {
  if (typeof value === "number") {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeRefreshInterval(seconds: number | null | undefined) {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) {
    return DEFAULT_PING_REFRESH_INTERVAL;
  }

  return Math.min(
    MAX_PING_REFRESH_INTERVAL,
    Math.max(MIN_PING_REFRESH_INTERVAL, seconds * 1000),
  );
}

function normalizeVisibleUuids(uuids: string[]) {
  return Array.from(new Set(uuids.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right),
  );
}

function stringifyBindings(bindings: HomepagePingTaskBindings) {
  return JSON.stringify(
    Object.entries(bindings)
      .map(([taskId, clients]) => [taskId, [...clients].sort((left, right) => left.localeCompare(right))])
      .sort(([left], [right]) => Number(left) - Number(right)),
  );
}

function equalSamples(
  a: PingOverviewItem["samples"],
  b: PingOverviewItem["samples"],
) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i]?.time !== b[i]?.time ||
      a[i]?.value !== b[i]?.value ||
      a[i]?.count !== b[i]?.count ||
      a[i]?.loss !== b[i]?.loss
    ) {
      return false;
    }
  }
  return true;
}

function equalPingItem(a: PingOverviewItem | undefined, b: PingOverviewItem | undefined) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.client === b.client &&
    a.isAssigned === b.isAssigned &&
    a.loadState === b.loadState &&
    a.lastValue === b.lastValue &&
    a.metricIntervalMs === b.metricIntervalMs &&
    a.windowMs === b.windowMs &&
    a.rangeEndMs === b.rangeEndMs &&
    a.pointCount === b.pointCount &&
    a.max === b.max &&
    a.loss === b.loss &&
    equalSamples(a.samples, b.samples)
  );
}

function equalPingLine(a: HomepagePingLine | undefined, b: HomepagePingLine | undefined) {
  return (
    a?.taskId === b?.taskId &&
    a?.taskName === b?.taskName &&
    equalPingItem(a, b)
  );
}

export function buildPingOverviewItems(
  taskId: number,
  records: PingRecord[],
  metricStats: PingTaskStats[] = [],
  metricIntervalSeconds?: number,
  metricWindowMs?: number,
  metricRangeEndMs?: number,
  metricPointCount?: number,
) {
  const metricIntervalMs =
    typeof metricIntervalSeconds === "number" &&
    Number.isFinite(metricIntervalSeconds) &&
    metricIntervalSeconds > 0
      ? metricIntervalSeconds * 1000
      : undefined;
  const selectedRecords = records.filter((record) => record.task_id === taskId);
  const grouped = new Map<string, Array<(typeof selectedRecords)[number]>>();
  const lossStatsByClient = new Map<string, { total: number; lost: number }>();

  for (const record of selectedRecords) {
    if (!record.client) continue;
    const current = grouped.get(record.client);
    if (current) current.push(record);
    else grouped.set(record.client, [record]);

    const stats = lossStatsByClient.get(record.client) ?? { total: 0, lost: 0 };
    const counts = resolvePingSampleCounts(record);
    stats.total += counts.total;
    stats.lost += counts.lost;
    lossStatsByClient.set(record.client, stats);
  }

  const result = new Map<string, PingOverviewItem>();
  const statsByClient = new Map(
    metricStats
      .filter((stat) => stat.taskId === taskId)
      .map((stat) => [stat.client, stat] as const),
  );
  const clients = new Set([...grouped.keys(), ...statsByClient.keys()]);

  for (const client of clients) {
    const clientRecords = grouped.get(client) ?? [];
    const sorted = [...clientRecords].sort(
      (left, right) => toTimestamp(left.time) - toTimestamp(right.time),
    );
    const latestRecord = sorted[sorted.length - 1];
    const samples: PingOverviewItem["samples"] = [];
    let max = 1;

    for (let i = 0; i < sorted.length; i++) {
      const record = sorted[i];
      const value = record.value;
      const time = toTimestamp(record.time);
      if (time > 0) {
        samples.push({
          time,
          value,
          count: "count" in record && typeof record.count === "number" ? record.count : undefined,
          loss: "loss" in record && typeof record.loss === "number" ? record.loss : undefined,
        });
      }
      if (typeof value === "number" && Number.isFinite(value) && value > max) {
        max = value;
      }
    }

    const lossStats = lossStatsByClient.get(client);
    const serverStats = statsByClient.get(client);
    result.set(client, {
      client,
      isAssigned: true,
      lastValue:
        serverStats?.latest ??
        (latestRecord && typeof latestRecord.value === "number" && latestRecord.value >= 0
          ? latestRecord.value
          : null),
      metricIntervalMs,
      ...(typeof metricWindowMs === "number" && Number.isFinite(metricWindowMs) && metricWindowMs > 0
        ? { windowMs: metricWindowMs }
        : {}),
      ...(typeof metricRangeEndMs === "number" && Number.isFinite(metricRangeEndMs) && metricRangeEndMs > 0
        ? { rangeEndMs: metricRangeEndMs }
        : {}),
      ...(typeof metricPointCount === "number" && Number.isFinite(metricPointCount) && metricPointCount > 0
        ? { pointCount: metricPointCount }
        : {}),
      samples,
      max: serverStats?.max ?? max,
      loss:
        serverStats?.loss ??
        (lossStats?.total ? (lossStats.lost / lossStats.total) * 100 : null),
    });
  }

  return result;
}

function buildAssignmentKey(selectedTaskIdsByClient: Map<string, number[]>) {
  return Array.from(selectedTaskIdsByClient.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([uuid, taskIds]) => `${uuid}:${taskIds.join(",")}`)
    .join("|");
}

function stringifyMultiPingGroups(groups: HomepageMultiPingGroup[]) {
  return groups
    .map((group) => {
      const taskIds = (group.taskIds ?? []).join(",");
      const clientUuids = (group.clientUuids ?? []).join(",");
      return `${taskIds}>${clientUuids}`;
    })
    .join("/");
}

function resolvePingAssignmentKey(
  clientUuids: string[],
  bindings: HomepagePingTaskBindings,
  multiTaskIds: number[],
  multiGroups: HomepageMultiPingGroup[] = [],
) {
  const normalizedUuids = normalizeVisibleUuids(clientUuids);
  const {
    singleTaskIdsByClient,
    multiTaskIdsByClient,
    requestedTaskIdsByClient,
  } = resolveHomepagePingSelections(normalizedUuids, bindings, multiTaskIds, multiGroups);
  const selectedTaskIds = new Set(
    Array.from(requestedTaskIdsByClient.values()).flat(),
  );
  if (selectedTaskIds.size === 0) return "";
  return [
    `single:${buildAssignmentKey(singleTaskIdsByClient)}`,
    `multi:${buildAssignmentKey(multiTaskIdsByClient)}`,
    `groups:${stringifyMultiPingGroups(multiGroups)}`,
  ].join("|");
}

// 限制 RPC 与兼容接口组成的整条回退链，避免一次刷新长期占住轮询。
const PING_REQUEST_TIMEOUT_MS = 35_000;
interface PreviousPingOverview {
  assignmentKey: string;
  singleItems: ReadonlyMap<string, PingOverviewItem>;
  multiLines: ReadonlyMap<string, HomepagePingLine[]>;
}

type PingOverviewStatsLoader = (
  hours: number,
  taskIds: number[],
  options?: { signal?: AbortSignal; entityIds?: string[] },
) => Promise<PingTaskStats[]>;

function assignedEmptyPing(
  client: string,
  loadState: PingOverviewTaskLoadState = "pending",
): PingOverviewItem {
  return {
    client,
    isAssigned: true,
    loadState,
    lastValue: null,
    samples: [],
    max: 1,
    loss: null,
  };
}

function assignedEmptyLine(
  client: string,
  taskId: number,
  taskName = getCfsmProbeName(taskId),
  loadState: PingOverviewTaskLoadState = "pending",
): HomepagePingLine {
  return {
    taskId,
    taskName,
    ...assignedEmptyPing(client, loadState),
  };
}

function mergePingOverviewStats(
  taskId: number,
  entityIds: string[],
  localStats: PingTaskStats[] | undefined,
  batchedStats: PingTaskStats[],
) {
  const allowedClients = new Set(entityIds);
  const merged = new Map<string, PingTaskStats>();
  for (const stat of localStats ?? []) {
    if (stat.taskId === taskId && allowedClients.has(stat.client)) {
      merged.set(stat.client, stat);
    }
  }
  // 批量接口包含更完整的分位数与标准差，应覆盖 records 本地推导出的同节点统计。
  for (const stat of batchedStats) {
    if (stat.taskId === taskId && allowedClients.has(stat.client)) {
      merged.set(stat.client, stat);
    }
  }
  return [...merged.values()];
}

export async function buildPingOverviewMap(
  hours: number,
  clientUuids: string[],
  bindings: HomepagePingTaskBindings,
  multiTaskIds: number[],
  signal?: AbortSignal,
  previous?: PreviousPingOverview,
  loadOverview: typeof getPingOverview = getPingOverview,
  loadStats?: PingOverviewStatsLoader,
  onProgress?: (result: PingOverviewMapResult) => void,
  multiGroups: HomepageMultiPingGroup[] = [],
): Promise<PingOverviewMapResult> {
  const normalizedUuids = normalizeVisibleUuids(clientUuids);
  if (normalizedUuids.length === 0) {
    return {
      assignmentKey: "",
      intervalMs: DEFAULT_PING_REFRESH_INTERVAL,
      singleItems: new Map<string, PingOverviewItem>(),
      multiLines: new Map<string, HomepagePingLine[]>(),
      successfulTaskIds: [],
      failedTaskIds: [],
      pendingTaskIds: [],
    };
  }

  const {
    singleTaskIdsByClient,
    multiTaskIdsByClient,
    requestedTaskIdsByClient,
  } = resolveHomepagePingSelections(
    normalizedUuids,
    bindings,
    multiTaskIds,
    multiGroups,
  );
  const selectedTaskIds = Array.from(
    new Set(Array.from(requestedTaskIdsByClient.values()).flat()),
  ).sort((left, right) => left - right);
  const assignmentKey = [
    `single:${buildAssignmentKey(singleTaskIdsByClient)}`,
    `multi:${buildAssignmentKey(multiTaskIdsByClient)}`,
  ].join("|");

  if (selectedTaskIds.length === 0) {
    return {
      assignmentKey: "",
      intervalMs: DEFAULT_PING_REFRESH_INTERVAL,
      singleItems: new Map<string, PingOverviewItem>(),
      multiLines: new Map<string, HomepagePingLine[]>(),
      successfulTaskIds: [],
      failedTaskIds: [],
      pendingTaskIds: [],
    };
  }

  type LoadedPingOverviewTask = {
    taskId: number;
    entityIds: string[];
    overview: Awaited<ReturnType<typeof getPingOverview>>;
  };

  const itemsByTask = new Map<number, Map<string, PingOverviewItem>>();
  const taskNames = new Map<number, string>();
  const successfulTaskIds = new Set<number>();
  const failedTaskIds = new Set<number>();
  const taskStates = new Map<number, PingOverviewTaskLoadState>(
    selectedTaskIds.map((taskId) => [taskId, "pending"]),
  );
  const refreshIntervals = new Map<number, number>();
  let batchedStats: PingTaskStats[] = [];

  // 结果 Map 只初始化一次。后续任务完成时通过反向索引更新受影响的节点，
  // 避免每个任务都重新遍历全部节点并重建占位对象。
  const singleItems = new Map<string, PingOverviewItem>();
  const multiLines = new Map<string, HomepagePingLine[]>();
  const singleUuidsByTask = new Map<number, string[]>();
  const multiUuidsByTask = new Map<number, string[]>();
  const changedUuids = new Set<string>();
  const hasPrevious = previous?.assignmentKey === assignmentKey;

  const addTaskUuid = (index: Map<number, string[]>, taskId: number, uuid: string) => {
    const uuids = index.get(taskId);
    if (uuids) uuids.push(uuid);
    else index.set(taskId, [uuid]);
  };

  for (const [uuid, taskIds] of singleTaskIdsByClient) {
    const taskId = taskIds[0];
    if (taskId == null) continue;
    addTaskUuid(singleUuidsByTask, taskId, uuid);
    const previousItem = hasPrevious ? previous?.singleItems.get(uuid) : undefined;
    const taskState = taskStates.get(taskId) ?? "pending";
    const displayState = taskState === "pending" && previousItem
      ? (previousItem.loadState ?? "ready")
      : taskState;
    singleItems.set(
      uuid,
      previousItem ? { ...previousItem, loadState: displayState } : assignedEmptyPing(uuid, displayState),
    );
    changedUuids.add(uuid);
  }

  for (const [uuid, taskIds] of multiTaskIdsByClient) {
    const previousLines = hasPrevious ? previous?.multiLines.get(uuid) : undefined;
    const lines = taskIds.map((taskId) => {
      addTaskUuid(multiUuidsByTask, taskId, uuid);
      const previousLine = previousLines?.find((line) => line.taskId === taskId);
      const taskState = taskStates.get(taskId) ?? "pending";
      const displayState = taskState === "pending" && previousLine
        ? (previousLine.loadState ?? "ready")
        : taskState;
      return previousLine
        ? { ...previousLine, loadState: displayState }
        : assignedEmptyLine(uuid, taskId, undefined, displayState);
    });
    multiLines.set(uuid, lines);
    changedUuids.add(uuid);
  }

  const updateSingleItem = (uuid: string, taskId: number) => {
    const current = singleItems.get(uuid);
    if (!current) return;
    const taskState = taskStates.get(taskId) ?? "pending";
    const displayState = taskState === "pending" ? (current.loadState ?? "ready") : taskState;
    const next = successfulTaskIds.has(taskId)
      ? {
          ...(itemsByTask.get(taskId)?.get(uuid) ?? assignedEmptyPing(uuid, "ready")),
          loadState: "ready" as const,
        }
      : { ...current, loadState: displayState };
    if (!equalPingItem(current, next)) {
      singleItems.set(uuid, next);
      changedUuids.add(uuid);
    }
  };

  const updateMultiLine = (uuid: string, taskId: number) => {
    const taskIds = multiTaskIdsByClient.get(uuid);
    const lines = multiLines.get(uuid);
    if (!taskIds || !lines) return;
    const index = taskIds.indexOf(taskId);
    if (index < 0) return;
    const current = lines[index];
    if (!current) return;
    const taskState = taskStates.get(taskId) ?? "pending";
    const displayState = taskState === "pending" ? (current.loadState ?? "ready") : taskState;
    const next = successfulTaskIds.has(taskId)
      ? {
          taskId,
          taskName: taskNames.get(taskId) ?? current.taskName ?? getCfsmProbeName(taskId),
          ...(itemsByTask.get(taskId)?.get(uuid) ?? assignedEmptyPing(uuid, "ready")),
          loadState: "ready" as const,
        }
      : { ...current, loadState: displayState };
    if (equalPingLine(current, next)) return;
    const nextLines = [...lines];
    nextLines[index] = next;
    multiLines.set(uuid, nextLines);
    changedUuids.add(uuid);
  };

  const updateTaskOutputs = (taskId: number) => {
    for (const uuid of singleUuidsByTask.get(taskId) ?? []) updateSingleItem(uuid, taskId);
    for (const uuid of multiUuidsByTask.get(taskId) ?? []) updateMultiLine(uuid, taskId);
  };

  const buildResult = (changed?: readonly string[]): PingOverviewMapResult => ({
    assignmentKey,
    intervalMs:
      refreshIntervals.size > 0
        ? Math.min(...refreshIntervals.values())
        : DEFAULT_PING_REFRESH_INTERVAL,
    singleItems,
    multiLines,
    successfulTaskIds: [...successfulTaskIds].sort((left, right) => left - right),
    failedTaskIds: [...failedTaskIds].sort((left, right) => left - right),
    pendingTaskIds: selectedTaskIds.filter((taskId) => taskStates.get(taskId) === "pending"),
    changedUuids: changed ? [...changed] : undefined,
  });

  const emitProgress = () => {
    if (!onProgress) return;
    const touched = [...changedUuids];
    changedUuids.clear();
    try {
      onProgress(buildResult(touched));
    } catch {
      // 进度订阅者不应改变 overview 请求的最终结果。
    }
  };

  const applyOverview = (loaded: LoadedPingOverviewTask) => {
    successfulTaskIds.add(loaded.taskId);
    failedTaskIds.delete(loaded.taskId);
    taskStates.set(loaded.taskId, "ready");
    const {
      taskId,
      entityIds,
      overview: { records, tasks, stats, intervalSeconds, windowMs, rangeEndMs, pointCount },
    } = loaded;
    const effectiveStats = mergePingOverviewStats(
      taskId,
      entityIds,
      stats,
      batchedStats,
    );
    const taskName =
      tasks.find((task) => task.id === taskId)?.name ||
      effectiveStats.find((stat) => stat.taskId === taskId)?.name;
    if (taskName) taskNames.set(taskId, taskName);
    itemsByTask.set(
      taskId,
      buildPingOverviewItems(taskId, records, effectiveStats, intervalSeconds, windowMs, rangeEndMs, pointCount),
    );

    const taskInterval =
      tasks.find((task) => task.id === taskId)?.interval ??
      effectiveStats.find((stat) => stat.taskId === taskId)?.interval;
    refreshIntervals.set(taskId, normalizeRefreshInterval(taskInterval));
    updateTaskOutputs(taskId);
  };

  // 先提交 pending 占位，让首帧保留固定的柱状区域；随后用一次 /api/servers
  // 快照构建所有三网线路，快照返回什么就渲染什么。
  emitProgress();

  try {
    batchedStats = loadStats
      ? await withTimeoutSignal(
          (requestSignal) =>
            loadStats(hours, selectedTaskIds, {
              signal: requestSignal,
              entityIds: normalizedUuids,
            }),
          PING_REQUEST_TIMEOUT_MS,
          signal,
        ).catch(() => [] as PingTaskStats[])
      : [];
    const overview = await withTimeoutSignal(
      (requestSignal) =>
        loadOverview(hours, undefined, {
          signal: requestSignal,
          entityIds: normalizedUuids,
          includeStats: true,
        }),
      PING_REQUEST_TIMEOUT_MS,
      signal,
    );
    for (const taskId of selectedTaskIds) {
      const entityIds = normalizedUuids.filter(
        (uuid) => requestedTaskIdsByClient.get(uuid)?.includes(taskId),
      );
      applyOverview({
        taskId,
        entityIds,
        overview: {
          ...overview,
          records: overview.records.filter((record) => record.task_id === taskId),
          tasks: overview.tasks.filter((task) => task.id === taskId),
          stats: overview.stats?.filter((stat) => stat.taskId === taskId),
        },
      });
    }
    emitProgress();
  } catch {
    for (const taskId of selectedTaskIds) {
      failedTaskIds.add(taskId);
      successfulTaskIds.delete(taskId);
      taskStates.set(taskId, "error");
      updateTaskOutputs(taskId);
    }
    emitProgress();
  }
  return buildResult();
}

interface PingOverviewStoreState {
  assignmentKey: string;
  intervalMs: number;
  singleItems: Map<string, PingOverviewItem>;
  multiLines: Map<string, HomepagePingLine[]>;
}

let pingOverviewState: PingOverviewStoreState = {
  assignmentKey: "",
  intervalMs: DEFAULT_PING_REFRESH_INTERVAL,
  singleItems: new Map(),
  multiLines: new Map(),
};
let pingOverviewStatus: PingOverviewStatusSnapshot = EMPTY_PING_STATUS;
let scheduledVisibleUuids: string[] = [];
let scheduledVisibleKey = "";
let scheduledBindings: HomepagePingTaskBindings = {};
let scheduledMultiTaskIds: number[] = [];
let scheduledMultiPingGroups: HomepageMultiPingGroup[] = [];
let scheduledSelectionKey = `${stringifyBindings({})}|multi:`;
let completedPingOverviewSelectionKey = "";
let pingRefreshInFlight = false;
let pingRefreshTimer: number | null = null;
let pingAbortController: AbortController | null = null;
let activeConsumers = 0;
// HMR dispose 后置真:阻止 in-flight 请求的 finally 恢复逻辑在旧模块实例上复活轮询。
let pingPollingDisposed = false;
const pingListeners = new Map<string, Set<Listener>>();

function setPingOverviewStatus(
  status: PingOverviewLoadState,
  isRefreshing: boolean,
) {
  if (
    pingOverviewStatus.status === status &&
    pingOverviewStatus.isRefreshing === isRefreshing
  ) {
    return;
  }
  pingOverviewStatus = { status, isRefreshing };
}

function stopPingPolling() {
  if (pingRefreshTimer != null) {
    window.clearTimeout(pingRefreshTimer);
    pingRefreshTimer = null;
  }
  // 中止进行中的 refresh（如果有），让它的请求和带宽在 teardown 时立刻释放；
  // refreshPingOverview 会把已 abort 的 signal 当成非当前，跳过 commit/重新调度。
  if (pingAbortController) {
    pingAbortController.abort();
    pingAbortController = null;
  }
}

function commitPingOverview(
  assignmentKey: string,
  intervalMs: number,
  singleItems: Map<string, PingOverviewItem>,
  multiLines: Map<string, HomepagePingLine[]>,
  options: {
    status?: PingOverviewLoadState;
    isRefreshing?: boolean;
    changedUuids?: readonly string[];
  } = {},
) {
  const touched = new Set<string>();
  const prevSingleItems = pingOverviewState.singleItems;
  const prevMultiLines = pingOverviewState.multiLines;
  const assignmentChanged = pingOverviewState.assignmentKey !== assignmentKey;
  const keys = options.changedUuids
    ? new Set(options.changedUuids)
    : new Set<string>([
        ...prevSingleItems.keys(),
        ...singleItems.keys(),
        ...prevMultiLines.keys(),
        ...multiLines.keys(),
      ]);
  const keysToCompare = assignmentChanged
    ? new Set<string>([
        ...keys,
        ...prevSingleItems.keys(),
        ...singleItems.keys(),
        ...prevMultiLines.keys(),
        ...multiLines.keys(),
      ])
    : keys;
  let nextSingleItems = prevSingleItems;
  let nextMultiLines = prevMultiLines;
  let singleCloned = false;
  let multiCloned = false;

  for (const key of keysToCompare) {
    const prev = prevSingleItems.get(key);
    const next = singleItems.get(key);
    if (!next) {
      if (prev) {
        if (!singleCloned) {
          nextSingleItems = new Map(prevSingleItems);
          singleCloned = true;
        }
        nextSingleItems.delete(key);
        touched.add(key);
      }
    } else if (!equalPingItem(prev, next)) {
      if (!singleCloned) {
        nextSingleItems = new Map(prevSingleItems);
        singleCloned = true;
      }
      nextSingleItems.set(key, next);
      touched.add(key);
    }

    const prevLines = prevMultiLines.get(key);
    const nextLines = multiLines.get(key);
    if (!nextLines) {
      if (prevLines) {
        if (!multiCloned) {
          nextMultiLines = new Map(prevMultiLines);
          multiCloned = true;
        }
        nextMultiLines.delete(key);
        touched.add(key);
      }
      continue;
    }
    const stable = nextLines.map((line, index) =>
      equalPingLine(prevLines?.[index], line) ? (prevLines?.[index] ?? line) : line,
    );
    const unchanged =
      prevLines?.length === stable.length &&
      stable.every((line, index) => line === prevLines[index]);
    if (!unchanged || !prevLines) {
      if (!multiCloned) {
        nextMultiLines = new Map(prevMultiLines);
        multiCloned = true;
      }
      nextMultiLines.set(key, stable);
      touched.add(key);
    }
  }

  const nextStatus =
    options.status ?? (options.isRefreshing ? "loading" : "ready");
  const nextIsRefreshing = options.isRefreshing ?? false;
  const dataUnchanged =
    pingOverviewState.assignmentKey === assignmentKey &&
    pingOverviewState.intervalMs === intervalMs &&
    touched.size === 0 &&
    nextSingleItems.size === prevSingleItems.size &&
    nextMultiLines.size === prevMultiLines.size;
  const statusUnchanged =
    pingOverviewStatus.status === nextStatus &&
    pingOverviewStatus.isRefreshing === nextIsRefreshing;

  if (dataUnchanged && statusUnchanged) {
    return;
  }

  if (!dataUnchanged) {
    pingOverviewState = {
      assignmentKey,
      intervalMs,
      singleItems: nextSingleItems,
      multiLines: nextMultiLines,
    };
  }

  setPingOverviewStatus(nextStatus, nextIsRefreshing);

  for (const key of touched) {
    const listeners = pingListeners.get(key);
    if (!listeners) continue;
    for (const listener of listeners) listener();
  }
}

async function refreshPingOverview() {
  if (pingPollingDisposed || pingRefreshInFlight) return;

  pingRefreshInFlight = true;
  const hasCachedOverview =
    pingOverviewStatus.status === "ready" &&
    (pingOverviewState.singleItems.size > 0 || pingOverviewState.multiLines.size > 0);
  setPingOverviewStatus(hasCachedOverview ? "ready" : "loading", true);
  const visibleKey = scheduledVisibleKey;
  const selectionKey = scheduledSelectionKey;
  const controller = new AbortController();
  pingAbortController = controller;
  const { signal } = controller;
  // 判断当前请求是否仍然有效（没被 stopPingPolling 中止，
  // 且 visible/binding 分配在执行期间没有被改掉）。
  const isCurrent = () =>
    !signal.aborted &&
    visibleKey === scheduledVisibleKey &&
    selectionKey === scheduledSelectionKey;

  try {
    if (scheduledVisibleUuids.length === 0) {
      commitPingOverview(
        "",
        DEFAULT_PING_REFRESH_INTERVAL,
        new Map(),
        new Map(),
      );
      return;
    }

    const next = await buildPingOverviewMap(
      1,
      scheduledVisibleUuids,
      scheduledBindings,
      scheduledMultiTaskIds,
      signal,
      undefined,
      getPingOverview,
      undefined,
      undefined,
      scheduledMultiPingGroups,
    );
    if (isCurrent()) {
      const hasRequestedTasks = next.assignmentKey.length > 0;
      const nextStatus: PingOverviewLoadState = !hasRequestedTasks
        ? "ready"
        : next.successfulTaskIds.length > 0
          ? "ready"
          : "error";
      commitPingOverview(
        next.assignmentKey,
        next.intervalMs,
        next.singleItems,
        next.multiLines,
        {
          status: nextStatus,
          isRefreshing: false,
        },
      );
      completedPingOverviewSelectionKey = selectionKey;
    }
  } catch {
    if (isCurrent()) {
      setPingOverviewStatus(
        hasCachedOverview ? "ready" : "error",
        false,
      );
    }
  } finally {
    pingRefreshInFlight = false;
    if (pingAbortController === controller) pingAbortController = null;
  }
}

function ensurePingOverviewStarted(
  visibleUuids: string[],
  bindings: HomepagePingTaskBindings,
  multiTaskIds: number[],
  multiGroups: HomepageMultiPingGroup[] = [],
) {
  const normalizedVisibleUuids = normalizeVisibleUuids(visibleUuids);
  const visibleKey = normalizedVisibleUuids.join("|");
  const selectionKey = `${stringifyBindings(bindings)}|multi:${multiTaskIds.join(",")}|groups:${stringifyMultiPingGroups(multiGroups)}`;

  if (
    scheduledVisibleKey !== visibleKey ||
    scheduledSelectionKey !== selectionKey
  ) {
    scheduledVisibleUuids = normalizedVisibleUuids;
    scheduledVisibleKey = visibleKey;
    scheduledBindings = bindings;
    scheduledMultiTaskIds = multiTaskIds;
    scheduledMultiPingGroups = multiGroups;
    scheduledSelectionKey = selectionKey;
    completedPingOverviewSelectionKey = "";

    pingAbortController?.abort();

    if (pingRefreshTimer != null) {
      window.clearTimeout(pingRefreshTimer);
      pingRefreshTimer = null;
    }
    const assignmentKey = resolvePingAssignmentKey(
      normalizedVisibleUuids,
      bindings,
      multiTaskIds,
      multiGroups,
    );
    commitPingOverview(
      assignmentKey,
      DEFAULT_PING_REFRESH_INTERVAL,
      new Map(),
      new Map(),
      {
        status: "loading",
        isRefreshing: true,
      },
    );
    void refreshPingOverview();
    return;
  }

  // 首页三网使用 /api/servers 快照；同一分配加载完成后不再轮询刷新。
  if (
    normalizedVisibleUuids.length > 0 &&
    completedPingOverviewSelectionKey !== selectionKey &&
    !pingRefreshInFlight &&
    pingRefreshTimer == null
  ) {
    void refreshPingOverview();
  }
}

function subscribeToPingItem(uuid: string, listener: Listener) {
  let listeners = pingListeners.get(uuid);
  if (!listeners) {
    listeners = new Set();
    pingListeners.set(uuid, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) {
      pingListeners.delete(uuid);
    }
  };
}

function getPingSnapshot(uuid: string) {
  return pingOverviewState.singleItems.get(uuid) ?? EMPTY_PING;
}

function getPingLinesSnapshot(uuid: string) {
  return pingOverviewState.multiLines.get(uuid) ?? EMPTY_PING_LINES;
}

export function useHomepagePingOverview(viewMode: NodeViewMode) {
  const { data: me } = useAuth();
  const visibleUuids = useVisibleNodeUuids(me?.logged_in === true);
  const themeSettings = useThemeSettings();

  // 主题级隐藏节点首页已不渲染,这里也从 overview 拉取里剔除——否则仍会为其绑定的
  // ping 任务发请求、做聚合,纯属无效网络/计算开销。
  const hiddenUuids = useHiddenNodeUuids();
  const effectiveUuids = useMemo(
    () =>
      hiddenUuids.size > 0
        ? visibleUuids.filter((uuid) => !hiddenUuids.has(uuid))
        : visibleUuids,
    [visibleUuids, hiddenUuids],
  );
  const requestMode = resolveHomepagePingRequestMode(
    viewMode,
    themeSettings.enableHomepageMultiPing,
    themeSettings.homepageMultiPingTaskIds,
    themeSettings.homepageMultiPingGroups,
  );
  const requestedBindings =
    requestMode === "single"
      ? themeSettings.homepagePingBindings
      : EMPTY_BINDINGS;
  const requestedMultiTaskIds =
    requestMode === "multi"
      ? CFSM_HOMEPAGE_MULTI_PING_TASK_IDS
      : EMPTY_TASK_IDS;
  const requestedMultiGroups = useMemo(
    () =>
      requestMode === "multi"
        ? themeSettings.homepageMultiPingGroups.map((group) => ({
            ...group,
            taskIds: CFSM_HOMEPAGE_MULTI_PING_TASK_IDS,
          }))
        : EMPTY_MULTI_PING_GROUPS,
    [requestMode, themeSettings.homepageMultiPingGroups],
  );
  const hasRequestedVisiblePing =
    resolvePingAssignmentKey(
      effectiveUuids,
      requestedBindings,
      requestedMultiTaskIds,
      requestedMultiGroups,
    ).length > 0;

  useLayoutEffect(() => {
    if (!themeSettings.isReady) return;
    // 空首页或全部节点被隐藏时不应触发 capability probe / 公开任务列表请求。
    if (hasRequestedVisiblePing) {
      prewarmPingOverviewDependencies();
    }
    activeConsumers += 1;
    ensurePingOverviewStarted(
      effectiveUuids,
      requestedBindings,
      requestedMultiTaskIds,
      requestedMultiGroups,
    );
    return () => {
      activeConsumers -= 1;
      if (activeConsumers <= 0) {
        activeConsumers = 0;
        stopPingPolling();
      }
    };
  }, [
    effectiveUuids,
    requestMode,
    requestedBindings,
    requestedMultiTaskIds,
    requestedMultiGroups,
    hasRequestedVisiblePing,
    themeSettings.isReady,
  ]);
}

export function useNodePingOverview(
  uuid: string,
  enabled = true,
): PingOverviewItem {
  const subscribe = useCallback(
    (cb: Listener) =>
      uuid && enabled ? subscribeToPingItem(uuid, cb) : () => undefined,
    [enabled, uuid],
  );
  const getSnapshot = useCallback(
    () => (uuid && enabled ? getPingSnapshot(uuid) : EMPTY_PING),
    [enabled, uuid],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useNodePingOverviewLines(
  uuid: string,
  enabled = true,
): HomepagePingLine[] {
  const subscribe = useCallback(
    (cb: Listener) =>
      uuid && enabled ? subscribeToPingItem(uuid, cb) : () => undefined,
    [enabled, uuid],
  );
  const getSnapshot = useCallback(
    () => (uuid && enabled ? getPingLinesSnapshot(uuid) : EMPTY_PING_LINES),
    [enabled, uuid],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function buildPingBuckets(
  ping: Pick<PingOverviewItem, "samples" | "metricIntervalMs" | "windowMs" | "rangeEndMs" | "pointCount">,
  count?: number,
  now = Date.now(),
): PingOverviewBucket[] {
  if (ping.pointCount != null && ping.samples.length > 0) {
    return ping.samples.map((sample, index) => {
      const loss =
        typeof sample.loss === "number" && Number.isFinite(sample.loss)
          ? Math.max(0, Math.min(100, sample.loss))
          : null;
      return {
        index,
        value:
          typeof sample.value === "number" && Number.isFinite(sample.value) && sample.value >= 0
            ? sample.value
            : null,
        loss,
        total: loss == null ? 0 : 1,
        lost: loss == null ? 0 : loss / 100,
        startAt: sample.time,
        endAt: null,
      };
    });
  }

  const totalWindowMs =
    typeof ping.windowMs === "number" && Number.isFinite(ping.windowMs) && ping.windowMs > 0
      ? ping.windowMs
      : 60 * 60 * 1000;
  const requestedCount = ping.pointCount ?? count ?? MAX_VISIBLE_HOMEPAGE_PING_BUCKETS;
  const boundedRequestedCount =
    Number.isFinite(requestedCount) && requestedCount > 0
      ? Math.min(240, Math.max(1, Math.round(requestedCount)))
      : MAX_VISIBLE_HOMEPAGE_PING_BUCKETS;
  const metricIntervalMs =
    typeof ping.metricIntervalMs === "number" &&
    Number.isFinite(ping.metricIntervalMs) &&
    ping.metricIntervalMs > 0
      ? ping.metricIntervalMs
      : 0;
  const resolvedCount = boundedRequestedCount;
  const bucketMs = totalWindowMs / resolvedCount;
  const windowEnd =
    typeof ping.rangeEndMs === "number" && Number.isFinite(ping.rangeEndMs) && ping.rangeEndMs > 0
      ? ping.rangeEndMs
      : now;
  const windowStart = windowEnd - totalWindowMs;
  const totals = new Array<number>(resolvedCount).fill(0);
  const losts = new Array<number>(resolvedCount).fill(0);
  const positiveSums = new Array<number>(resolvedCount).fill(0);
  const positiveCounts = new Array<number>(resolvedCount).fill(0);

  const addSampleToBucket = (
    bucketIndex: number,
    sample: PingOverviewItem["samples"][number],
  ) => {
    const { total: sampleCount, lost: sampleLost, valid: sampleValid } =
      resolvePingSampleCounts(sample);

    totals[bucketIndex] += sampleCount;
    losts[bucketIndex] += sampleLost;
    // 聚合点的 value 已由 metric 适配层恢复为“成功样本均值”，这里按 valid count
    // 加权；旧接口/模拟数据没有 count，仍等价于单样本累加。
    if (
      typeof sample.value === "number" &&
      Number.isFinite(sample.value) &&
      sample.value >= 0 &&
      sampleValid > 0
    ) {
      positiveSums[bucketIndex] += sample.value * sampleValid;
      positiveCounts[bucketIndex] += sampleValid;
    }
  };

  for (const sample of ping.samples ?? []) {
    if (metricIntervalMs > bucketMs) {
      const sampleEnd = sample.time + metricIntervalMs;
      if (sampleEnd <= windowStart || sample.time > windowEnd) continue;

      // 后端时间戳是聚合桶起点。以每个可视 bucket 的中点判断它属于哪个
      // 聚合区间，相当于对粗粒度数据做 sample-and-hold：不会制造规律性空洞，
      // 也不会因为减少 DOM 数量而让不同节点的柱宽不一致。
      for (let index = 0; index < resolvedCount; index += 1) {
        const midpoint = windowStart + (index + 0.5) * bucketMs;
        if (midpoint >= sample.time && midpoint < sampleEnd) {
          addSampleToBucket(index, sample);
        }
      }
      continue;
    }

    let sampleTime = sample.time;
    if (metricIntervalMs > 0) {
      const sampleEnd = sample.time + metricIntervalMs;
      if (sampleEnd <= windowStart || sample.time > now) continue;
      const overlapStart = Math.max(sample.time, windowStart);
      const overlapEnd = Math.min(sampleEnd, windowEnd);
      if (overlapEnd < overlapStart) continue;
      sampleTime = overlapStart + (overlapEnd - overlapStart) / 2;
    } else if (sample.time < windowStart || sample.time > windowEnd) {
      continue;
    }

    let bucketIndex = Math.floor((sampleTime - windowStart) / bucketMs);
    if (bucketIndex < 0) continue;
    if (bucketIndex >= resolvedCount) bucketIndex = resolvedCount - 1;
    addSampleToBucket(bucketIndex, sample);
  }

  return Array.from({ length: resolvedCount }, (_, index) => {
    const startAt = windowStart + index * bucketMs;
    const endAt = startAt + bucketMs;
    const total = totals[index];
    const lost = losts[index];
    const positiveCount = positiveCounts[index];

    return {
      index,
      value: positiveCount > 0 ? positiveSums[index] / positiveCount : null,
      loss: total > 0 ? (lost / total) * 100 : null,
      total,
      lost,
      startAt,
      endAt,
    };
  });
}

export function usePingBuckets(
  ping: Pick<PingOverviewItem, "samples" | "metricIntervalMs" | "windowMs" | "rangeEndMs" | "pointCount">,
  count?: number,
  enabled = true,
): PingOverviewBucket[] {
  const { samples, metricIntervalMs, windowMs, rangeEndMs, pointCount } = ping;
  // 轮询返回同引用数据时窗口也要随时间前移,否则时间轴最多滞后约 2 个桶;分钟粒度足够
  // (桶宽 ≥150s),也避免每个 ws tick 都重算。
  const now = useMinuteClock(enabled);
  return useMemo(
    () =>
      enabled
        ? buildPingBuckets({ samples, metricIntervalMs, windowMs, rangeEndMs, pointCount }, count, now)
        : EMPTY_PING_BUCKETS,
    [count, enabled, metricIntervalMs, now, pointCount, rangeEndMs, samples, windowMs],
  );
}

// 模块级定时器/请求在热更新时必须停掉,否则新旧两个模块实例会并行轮询。
// disposed 标志 + 清零消费者计数:in-flight 请求的 finally 恢复逻辑不会再重启旧模块的轮询。
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    pingPollingDisposed = true;
    activeConsumers = 0;
    stopPingPolling();
  });
}
