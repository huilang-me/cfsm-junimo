import type { NodeInfo, NodeMetrics, NodeRealtime, TrafficTrendSample } from "@/types/cfsm";
import {
  getApiBases,
  getNodeSnapshot,
  getNodeSnapshots,
  getWsBase,
  mapServerToLatestRecord,
  mapServerToNodeInfo,
} from "@/services/api";
import { parseGpuUtil, parseProbeMetricValue } from "@/utils/cfsmProbeMetrics";

type Listener = () => void;
type RealtimePayload = Record<string, unknown>;

interface State {
  metaByUuid: Record<string, NodeInfo>;
  metricsByUuid: Record<string, NodeMetrics>;
  trafficTrends: Record<string, NodeTrafficTrend>;
  order: string[];
  failureStreak: number;
}

export interface StoreStatusSnapshot {
  failureStreak: number;
  hydrated: boolean;
  nodeInfoError: boolean;
}

export interface HomeNodeSummary {
  uuid: string;
  group: string;
  region: string;
  hidden: boolean;
  weight: number;
  online: boolean | null;
  trafficUp: number;
  trafficDown: number;
  netUp: number;
  netDown: number;
}

export interface NodeOnlineSummary {
  uuid: string;
  online: boolean | null;
}

interface NodeSnapshot {
  meta: NodeInfo;
  latest: Record<string, unknown>;
}

interface TrafficTrendSeries {
  buffer: TrafficTrendSample[];
  start: number;
  size: number;
  signature: string;
  snapshot: TrafficTrendSample[];
}

interface NodeTrafficTrend {
  up: TrafficTrendSeries;
  down: TrafficTrendSeries;
  snapshot: {
    up: TrafficTrendSample[];
    down: TrafficTrendSample[];
  };
}

const TRAFFIC_TREND_SAMPLE_COUNT = 18;
const EMPTY_TRAFFIC_TREND_SAMPLE: TrafficTrendSample = {
  value: 0,
  level: 0.25,
  opacity: 0.52,
};
const EMPTY_TRAFFIC_TREND_SNAPSHOT = Array.from(
  { length: TRAFFIC_TREND_SAMPLE_COUNT },
  () => EMPTY_TRAFFIC_TREND_SAMPLE,
);
const EMPTY_TRAFFIC_TREND_SERIES: TrafficTrendSeries = {
  buffer: [],
  start: 0,
  size: 0,
  signature: "",
  snapshot: EMPTY_TRAFFIC_TREND_SNAPSHOT,
};
const EMPTY_NODE_TRAFFIC_TREND_SNAPSHOT = {
  up: EMPTY_TRAFFIC_TREND_SNAPSHOT,
  down: EMPTY_TRAFFIC_TREND_SNAPSHOT,
};
const EMPTY_TRAFFIC_TREND: NodeTrafficTrend = {
  up: EMPTY_TRAFFIC_TREND_SERIES,
  down: EMPTY_TRAFFIC_TREND_SERIES,
  snapshot: EMPTY_NODE_TRAFFIC_TREND_SNAPSHOT,
};

function emptyState(): State {
  return {
    metaByUuid: {},
    metricsByUuid: {},
    trafficTrends: {},
    order: [],
    failureStreak: 0,
  };
}

function emptyMetrics(info: NodeInfo, online: boolean | null): NodeMetrics {
  return {
    online,
    cpuPct: 0,
    ramUsed: 0,
    ramTotal: info.mem_total,
    ramPct: 0,
    swapUsed: 0,
    swapTotal: info.swap_total,
    diskUsed: 0,
    diskTotal: info.disk_total,
    diskPct: 0,
    netUp: 0,
    netDown: 0,
    trafficUp: 0,
    trafficDown: 0,
    uptime: 0,
    load1: 0,
    load5: 0,
    load15: 0,
    process: 0,
    connectionsTcp: 0,
    connectionsUdp: 0,
    updatedAt: 0,
    gpuUtil: null,
    diskReadBps: null,
    diskWriteBps: null,
    diskReadIops: null,
    diskWriteIops: null,
    diskAwaitMs: null,
    diskUtil: null,
    pingCt: null,
    pingCu: null,
    pingCm: null,
    pingBd: null,
    lossCt: null,
    lossCu: null,
    lossCm: null,
    lossBd: null,
  };
}

function alignEmptyMetricsTotals(metrics: NodeMetrics, info: NodeInfo): NodeMetrics {
  if (metrics.updatedAt > 0) return metrics;
  if (
    metrics.ramTotal === info.mem_total &&
    metrics.swapTotal === info.swap_total &&
    metrics.diskTotal === info.disk_total
  ) {
    return metrics;
  }

  return {
    ...metrics,
    ramTotal: info.mem_total,
    swapTotal: info.swap_total,
    diskTotal: info.disk_total,
  };
}

// 累计流量直接跟随后端计数器下降；0 视为本帧缺样，避免局部帧闪零。
export function resolveTrafficTotal(previous: number, raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : previous;
}

function resolveTrafficTotals(previous: NodeMetrics, nextUp: number, nextDown: number) {
  return {
    up: resolveTrafficTotal(previous.trafficUp, nextUp),
    down: resolveTrafficTotal(previous.trafficDown, nextDown),
  };
}

function mergeRealtime(
  metrics: NodeMetrics,
  rt: NodeRealtime,
  online: boolean,
): NodeMetrics {
  const ramUsed = rt.ram.used;
  const ramTotal = rt.ram.total;
  const swapUsed = rt.swap.used;
  const swapTotal = rt.swap.total;
  const diskUsed = rt.disk.used;
  const diskTotal = rt.disk.total;
  const updatedAt = toTimestamp(rt.updated_at);
  const trafficTotals = resolveTrafficTotals(
    metrics,
    rt.network?.totalUp ?? 0,
    rt.network?.totalDown ?? 0,
  );

  return {
    online,
    cpuPct: rt.cpu?.usage ?? 0,
    ramUsed,
    ramTotal,
    ramPct: ramTotal > 0 ? (ramUsed / ramTotal) * 100 : 0,
    swapUsed,
    swapTotal,
    diskUsed,
    diskTotal,
    diskPct: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0,
    netUp: rt.network?.up ?? 0,
    netDown: rt.network?.down ?? 0,
    trafficUp: trafficTotals.up,
    trafficDown: trafficTotals.down,
    uptime: rt.uptime ?? 0,
    load1: rt.load?.load1 ?? 0,
    load5: rt.load?.load5 ?? 0,
    load15: rt.load?.load15 ?? 0,
    process: rt.process ?? 0,
    connectionsTcp: rt.connections?.tcp ?? 0,
    connectionsUdp: rt.connections?.udp ?? 0,
    updatedAt: updatedAt > 0 ? updatedAt : metrics.updatedAt,
    gpuUtil: rt.gpuUtil !== undefined ? rt.gpuUtil : metrics.gpuUtil,
    diskReadBps: rt.diskReadBps !== undefined ? rt.diskReadBps : metrics.diskReadBps,
    diskWriteBps: rt.diskWriteBps !== undefined ? rt.diskWriteBps : metrics.diskWriteBps,
    diskReadIops: rt.diskReadIops !== undefined ? rt.diskReadIops : metrics.diskReadIops,
    diskWriteIops: rt.diskWriteIops !== undefined ? rt.diskWriteIops : metrics.diskWriteIops,
    diskAwaitMs: rt.diskAwaitMs !== undefined ? rt.diskAwaitMs : metrics.diskAwaitMs,
    diskUtil: rt.diskUtil !== undefined ? rt.diskUtil : metrics.diskUtil,
    pingCt: rt.pingCt !== undefined ? rt.pingCt : metrics.pingCt,
    pingCu: rt.pingCu !== undefined ? rt.pingCu : metrics.pingCu,
    pingCm: rt.pingCm !== undefined ? rt.pingCm : metrics.pingCm,
    pingBd: rt.pingBd !== undefined ? rt.pingBd : metrics.pingBd,
    lossCt: rt.lossCt !== undefined ? rt.lossCt : metrics.lossCt,
    lossCu: rt.lossCu !== undefined ? rt.lossCu : metrics.lossCu,
    lossCm: rt.lossCm !== undefined ? rt.lossCm : metrics.lossCm,
    lossBd: rt.lossBd !== undefined ? rt.lossBd : metrics.lossBd,
  };
}

function shallowEqualMetrics(a: NodeMetrics, b: NodeMetrics) {
  return (
    a.online === b.online &&
    a.cpuPct === b.cpuPct &&
    a.ramUsed === b.ramUsed &&
    a.ramTotal === b.ramTotal &&
    a.ramPct === b.ramPct &&
    a.swapUsed === b.swapUsed &&
    a.swapTotal === b.swapTotal &&
    a.diskUsed === b.diskUsed &&
    a.diskTotal === b.diskTotal &&
    a.diskPct === b.diskPct &&
    a.netUp === b.netUp &&
    a.netDown === b.netDown &&
    a.trafficUp === b.trafficUp &&
    a.trafficDown === b.trafficDown &&
    a.uptime === b.uptime &&
    a.load1 === b.load1 &&
    a.load5 === b.load5 &&
    a.load15 === b.load15 &&
    a.process === b.process &&
    a.connectionsTcp === b.connectionsTcp &&
    a.connectionsUdp === b.connectionsUdp &&
    a.updatedAt === b.updatedAt &&
    a.gpuUtil === b.gpuUtil &&
    a.diskReadBps === b.diskReadBps &&
    a.diskWriteBps === b.diskWriteBps &&
    a.diskReadIops === b.diskReadIops &&
    a.diskWriteIops === b.diskWriteIops &&
    a.diskAwaitMs === b.diskAwaitMs &&
    a.diskUtil === b.diskUtil &&
    a.pingCt === b.pingCt &&
    a.pingCu === b.pingCu &&
    a.pingCm === b.pingCm &&
    a.pingBd === b.pingBd &&
    a.lossCt === b.lossCt &&
    a.lossCu === b.lossCu &&
    a.lossCm === b.lossCm &&
    a.lossBd === b.lossBd
  );
}

function shallowEqualNodeInfo(a: NodeInfo, b: NodeInfo) {
  return (
    a.uuid === b.uuid &&
    a.name === b.name &&
    a.group === b.group &&
    a.region === b.region &&
    a.hidden === b.hidden &&
    a.ipv4 === b.ipv4 &&
    a.ipv6 === b.ipv6 &&
    a.cpu_name === b.cpu_name &&
    a.cpu_cores === b.cpu_cores &&
    a.arch === b.arch &&
    a.virtualization === b.virtualization &&
    a.os === b.os &&
    a.kernel_version === b.kernel_version &&
    a.gpu_name === b.gpu_name &&
    a.mem_total === b.mem_total &&
    a.swap_total === b.swap_total &&
    a.disk_total === b.disk_total &&
    a.weight === b.weight &&
    a.price === b.price &&
    a.billing_cycle === b.billing_cycle &&
    a.auto_renewal === b.auto_renewal &&
    a.currency === b.currency &&
    a.expired_at === b.expired_at &&
    a.tags === b.tags &&
    a.public_remark === b.public_remark &&
    a.traffic_limit === b.traffic_limit &&
    a.traffic_limit_type === b.traffic_limit_type &&
    a.created_at === b.created_at
    // updated_at 是未展示的心跳字段，不应触发整个节点列表重渲染。
  );
}

function materializeTrafficTrendSnapshot(
  buffer: TrafficTrendSample[],
  start: number,
  size: number,
) {
  if (size <= 0) return EMPTY_TRAFFIC_TREND_SNAPSHOT;

  const snapshot = new Array<TrafficTrendSample>(TRAFFIC_TREND_SAMPLE_COUNT);
  const padding = TRAFFIC_TREND_SAMPLE_COUNT - size;

  for (let i = 0; i < padding; i++) {
    snapshot[i] = EMPTY_TRAFFIC_TREND_SAMPLE;
  }

  for (let i = 0; i < size; i++) {
    snapshot[padding + i] = buffer[(start + i) % TRAFFIC_TREND_SAMPLE_COUNT]!;
  }

  return snapshot;
}

function updateTrafficTrendSeries(
  prevSeries: TrafficTrendSeries,
  value: number,
  updatedAt: number,
  online: boolean | null,
) {
  if (online === false) {
    if (!prevSeries.signature && prevSeries.size === 0) {
      return { series: prevSeries, changed: false };
    }
    return { series: EMPTY_TRAFFIC_TREND_SERIES, changed: true };
  }

  const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
  const signature = `${updatedAt || 0}:${safeValue}`;
  if (signature === prevSeries.signature) {
    return { series: prevSeries, changed: false };
  }

  let visibleMax = safeValue > 0 ? safeValue : 1;
  for (let i = 0; i < prevSeries.size; i++) {
    const sample = prevSeries.buffer[(prevSeries.start + i) % TRAFFIC_TREND_SAMPLE_COUNT];
    if (sample && sample.value > visibleMax) {
      visibleMax = sample.value;
    }
  }

  const level = safeValue > 0 ? Math.max(0.2, Math.min(1, safeValue / visibleMax)) : 0.25;
  const nextSample: TrafficTrendSample = {
    value: safeValue,
    level,
    opacity: safeValue > 0 ? 0.4 + level * 0.48 : 0.52,
  };

  const buffer = new Array<TrafficTrendSample>(TRAFFIC_TREND_SAMPLE_COUNT);
  const nextSize =
    prevSeries.size < TRAFFIC_TREND_SAMPLE_COUNT
      ? prevSeries.size + 1
      : TRAFFIC_TREND_SAMPLE_COUNT;
  const nextStart =
    prevSeries.size < TRAFFIC_TREND_SAMPLE_COUNT
      ? prevSeries.start
      : (prevSeries.start + 1) % TRAFFIC_TREND_SAMPLE_COUNT;
  const insertIndex =
    prevSeries.size < TRAFFIC_TREND_SAMPLE_COUNT
      ? (prevSeries.start + prevSeries.size) % TRAFFIC_TREND_SAMPLE_COUNT
      : prevSeries.start;

  if (prevSeries.size > 0) {
    for (let i = 0; i < prevSeries.size; i++) {
      buffer[(prevSeries.start + i) % TRAFFIC_TREND_SAMPLE_COUNT] =
        prevSeries.buffer[(prevSeries.start + i) % TRAFFIC_TREND_SAMPLE_COUNT]!;
    }
  }
  buffer[insertIndex] = nextSample;

  return {
    series: {
      buffer,
      start: nextStart,
      size: nextSize,
      signature,
      snapshot: materializeTrafficTrendSnapshot(buffer, nextStart, nextSize),
    },
    changed: true,
  };
}

let state: State = emptyState();
const visibleNodeListeners = new Set<Listener>();
const allNodesListeners = new Set<Listener>();
const homeNodeSummaryListeners = new Set<Listener>();
const nodeOnlineSummaryListeners = new Set<Listener>();
const storeStatusListeners = new Set<Listener>();
const nodeMetaListeners = new Map<string, Set<Listener>>();
const nodeMetricsListeners = new Map<string, Set<Listener>>();
const trafficTrendListeners = new Map<string, Set<Listener>>();
let storeVersion = 0;
let visibleNodeUuidsSnapshot: string[] = [];
let visibleNodeUuidsSnapshotVersion = -1;
let visibleNodeUuidsWithHiddenSnapshot: string[] = [];
let visibleNodeUuidsWithHiddenSnapshotVersion = -1;
let allNodeMetaSnapshot: NodeInfo[] = [];
let allNodeMetaSnapshotVersion = -1;
let homeNodeSummariesSnapshot: HomeNodeSummary[] = [];
let homeNodeSummariesSnapshotVersion = -1;
let nodeOnlineSummariesSnapshot: NodeOnlineSummary[] = [];
let nodeOnlineSummariesSnapshotVersion = -1;
let nodeOnlineSummariesVersion = 0;
let storeStatusSnapshot: StoreStatusSnapshot = {
  failureStreak: 0,
  hydrated: false,
  nodeInfoError: false,
};

interface CommitTouches {
  meta?: Iterable<string>;
  metrics?: Iterable<string>;
  trafficTrends?: Iterable<string>;
  nodeList?: boolean;
  allNodes?: boolean;
  storeStatus?: boolean;
}

function emitListeners(listeners: Iterable<Listener>) {
  for (const listener of listeners) listener();
}

function emitMappedListeners(
  listenersByKey: Map<string, Set<Listener>>,
  keys: Iterable<string>,
) {
  for (const key of keys) {
    const listeners = listenersByKey.get(key);
    if (listeners) emitListeners(listeners);
  }
}

function hasAny(items: Iterable<string> | undefined): boolean {
  if (!items) return false;
  return !items[Symbol.iterator]().next().done;
}

function commit(next: State, touches: CommitTouches = {}) {
  const previous = state;
  const onlineTouched =
    Boolean(touches.nodeList) ||
    (touches.metrics
      ? Array.from(touches.metrics).some(
          (uuid) =>
            (previous.metricsByUuid[uuid]?.online ?? null) !==
            (next.metricsByUuid[uuid]?.online ?? null),
        )
      : false);
  state = next;
  // 派生快照以 storeVersion 作缓存键。
  storeVersion += 1;
  // 空集合也是 truthy，需检查内容才能避免误广播。
  const homeTouched =
    Boolean(touches.nodeList || touches.allNodes) ||
    hasAny(touches.meta) ||
    hasAny(touches.metrics);

  if (touches.nodeList) emitListeners(visibleNodeListeners);
  if (touches.allNodes) emitListeners(allNodesListeners);
  if (homeTouched) emitListeners(homeNodeSummaryListeners);
  if (onlineTouched) {
    nodeOnlineSummariesVersion += 1;
    emitListeners(nodeOnlineSummaryListeners);
  }
  if (touches.storeStatus) emitListeners(storeStatusListeners);
  if (touches.meta) {
    emitMappedListeners(nodeMetaListeners, touches.meta);
  }
  if (touches.metrics) {
    emitMappedListeners(nodeMetricsListeners, touches.metrics);
  }
  if (touches.trafficTrends) emitMappedListeners(trafficTrendListeners, touches.trafficTrends);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asRecord(value: unknown): RealtimePayload {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RealtimePayload)
    : {};
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "" || normalized === "0" || normalized === "false") return false;
    if (normalized === "1" || normalized === "true") return true;
  }
  return fallback;
}

function resolveOnline(rawRecord: unknown): boolean {
  if (rawRecord == null) return false;
  if (typeof rawRecord === "boolean") return rawRecord;
  const record = asRecord(rawRecord);
  return asBoolean(record.online, Object.keys(record).length > 0);
}

function toTimestamp(value: string | number | undefined): number {
  if (typeof value === "number") {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function pickNumber(payload: RealtimePayload, keys: string[], fallback = 0): number {
  for (const key of keys) {
    if (payload[key] != null) return asNumber(payload[key], fallback);
  }
  return fallback;
}

function metricBytes(value: unknown, fallback = 0): number {
  const number = asNumber(value, fallback);
  if (number <= 0) return 0;
  return number < 10_000_000 ? number * 1024 * 1024 : number;
}

function parseLoadTriplet(value: unknown): [number, number, number] {
  if (Array.isArray(value)) {
    return [asNumber(value[0]), asNumber(value[1]), asNumber(value[2])];
  }
  const parts = String(value ?? "").trim().split(/\s+/);
  return [asNumber(parts[0]), asNumber(parts[1]), asNumber(parts[2])];
}

function pickProbeMetric(payload: RealtimePayload, key: string) {
  return Object.prototype.hasOwnProperty.call(payload, key)
    ? parseProbeMetricValue(payload[key])
    : undefined;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = asNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickDiskIoMetric(payload: RealtimePayload, disk: RealtimePayload, flatKey: string, diskKey: string) {
  if (Object.prototype.hasOwnProperty.call(payload, flatKey)) {
    return optionalNumber(payload[flatKey]);
  }
  if (Object.prototype.hasOwnProperty.call(disk, diskKey)) {
    return optionalNumber(disk[diskKey]);
  }
  return undefined;
}

// 旧扁平协议的 connections 是 TCP+UDP 合计。
export function resolveFlatConnectionsTcp(payload: RealtimePayload): number {
  if (payload.connections_tcp != null) return asNumber(payload.connections_tcp);
  if (payload.tcp_conn != null) return asNumber(payload.tcp_conn);
  return Math.max(0, asNumber(payload.connections) - asNumber(payload.connections_udp));
}

function normalizeRealtime(
  raw: unknown,
  meta: NodeInfo,
  metrics: NodeMetrics,
): NodeRealtime | null {
  const payload = asRecord(raw);
  if (Object.keys(payload).length === 0) return null;

  const cpu = asRecord(payload.cpu);
  const ram = asRecord(payload.ram);
  const swap = asRecord(payload.swap);
  const load = asRecord(payload.load);
  const disk = asRecord(payload.disk);
  const network = asRecord(payload.network);
  const connections = asRecord(payload.connections);
  const hasNestedShape =
    Object.keys(cpu).length > 0 ||
    Object.keys(ram).length > 0 ||
    Object.keys(network).length > 0;

  if (hasNestedShape) {
    return {
      cpu: { usage: asNumber(cpu.usage) },
      ram: {
        total: asNumber(ram.total, metrics.ramTotal || meta.mem_total),
        used: asNumber(ram.used),
      },
      swap: {
        total: asNumber(swap.total, metrics.swapTotal || meta.swap_total),
        used: asNumber(swap.used),
      },
      load: {
        load1: asNumber(load.load1),
        load5: asNumber(load.load5),
        load15: asNumber(load.load15),
      },
      disk: {
        total: asNumber(disk.total, metrics.diskTotal || meta.disk_total),
        used: asNumber(disk.used),
      },
      network: {
        up: asNumber(network.up),
        down: asNumber(network.down),
        totalUp: asNumber(network.totalUp),
        totalDown: asNumber(network.totalDown),
      },
      connections: {
        tcp: asNumber(connections.tcp),
        udp: asNumber(connections.udp),
      },
      uptime: asNumber(payload.uptime),
      process: asNumber(payload.process),
      updated_at: (payload.updated_at ?? payload.time) as string | number | undefined,
      gpuUtil: Object.prototype.hasOwnProperty.call(payload, "gpu_info")
        ? parseGpuUtil(payload.gpu_info)
        : undefined,
      diskReadBps: pickDiskIoMetric(payload, disk, "disk_read_bps", "read_bps"),
      diskWriteBps: pickDiskIoMetric(payload, disk, "disk_write_bps", "write_bps"),
      diskReadIops: pickDiskIoMetric(payload, disk, "disk_read_iops", "read_iops"),
      diskWriteIops: pickDiskIoMetric(payload, disk, "disk_write_iops", "write_iops"),
      diskAwaitMs: pickDiskIoMetric(payload, disk, "disk_await_ms", "await_ms"),
      diskUtil: pickDiskIoMetric(payload, disk, "disk_util", "util"),
      pingCt: pickProbeMetric(payload, "ping_ct"),
      pingCu: pickProbeMetric(payload, "ping_cu"),
      pingCm: pickProbeMetric(payload, "ping_cm"),
      pingBd: pickProbeMetric(payload, "ping_bd"),
      lossCt: pickProbeMetric(payload, "loss_ct"),
      lossCu: pickProbeMetric(payload, "loss_cu"),
      lossCm: pickProbeMetric(payload, "loss_cm"),
      lossBd: pickProbeMetric(payload, "loss_bd"),
    };
  }

  const [load1, load5, load15] = parseLoadTriplet(payload.load_avg ?? payload.load);

  return {
    cpu: { usage: asNumber(payload.cpu) },
    ram: {
      total: metricBytes(payload.ram_total, metrics.ramTotal || meta.mem_total),
      used: metricBytes(pickNumber(payload, ["ram_used", "ram"])),
    },
    swap: {
      total: metricBytes(payload.swap_total, metrics.swapTotal || meta.swap_total),
      used: metricBytes(pickNumber(payload, ["swap_used", "swap"])),
    },
    load: {
      load1,
      load5,
      load15,
    },
    disk: {
      total: metricBytes(payload.disk_total, metrics.diskTotal || meta.disk_total),
      used: metricBytes(pickNumber(payload, ["disk_used", "disk"])),
    },
    network: {
      up: pickNumber(payload, ["net_out_speed", "net_out"]),
      down: pickNumber(payload, ["net_in_speed", "net_in"]),
      totalUp: pickNumber(payload, ["net_tx_monthly", "net_tx", "net_total_up"]),
      totalDown: pickNumber(payload, ["net_rx_monthly", "net_rx", "net_total_down"]),
    },
    connections: {
      tcp: resolveFlatConnectionsTcp(payload),
      udp: pickNumber(payload, ["udp_conn", "connections_udp"]),
    },
    uptime: asNumber(payload.uptime),
    process: pickNumber(payload, ["processes", "process"]),
    updated_at: (payload.updated_at ?? payload.last_updated ?? payload.timestamp ?? payload.time) as
      | string
      | number
      | undefined,
    gpuUtil: Object.prototype.hasOwnProperty.call(payload, "gpu_info")
      ? parseGpuUtil(payload.gpu_info)
      : undefined,
    diskReadBps: pickDiskIoMetric(payload, disk, "disk_read_bps", "read_bps"),
    diskWriteBps: pickDiskIoMetric(payload, disk, "disk_write_bps", "write_bps"),
    diskReadIops: pickDiskIoMetric(payload, disk, "disk_read_iops", "read_iops"),
    diskWriteIops: pickDiskIoMetric(payload, disk, "disk_write_iops", "write_iops"),
    diskAwaitMs: pickDiskIoMetric(payload, disk, "disk_await_ms", "await_ms"),
    diskUtil: pickDiskIoMetric(payload, disk, "disk_util", "util"),
    pingCt: pickProbeMetric(payload, "ping_ct"),
    pingCu: pickProbeMetric(payload, "ping_cu"),
    pingCm: pickProbeMetric(payload, "ping_cm"),
    pingBd: pickProbeMetric(payload, "ping_bd"),
    lossCt: pickProbeMetric(payload, "loss_ct"),
    lossCu: pickProbeMetric(payload, "loss_cu"),
    lossCm: pickProbeMetric(payload, "loss_cm"),
    lossBd: pickProbeMetric(payload, "loss_bd"),
  };
}

function applyLatestStatus(records: Record<string, unknown>) {
  const touchedMetrics = new Set<string>();
  const touchedTrafficTrends = new Set<string>();
  // 安静 tick 不克隆整个索引。
  let nextMetricsByUuid = state.metricsByUuid;
  let nextTrafficTrends = state.trafficTrends;

  for (const uuid of Object.keys(records)) {
    const meta = state.metaByUuid[uuid];
    const prev = state.metricsByUuid[uuid];
    if (!meta || !prev) continue;
    const rawRecord = records[uuid];
    const online = resolveOnline(rawRecord);
    const realtime = normalizeRealtime(rawRecord, meta, prev);
    const merged = realtime
      ? mergeRealtime(prev, realtime, online)
      : { ...prev, online };

    if (!shallowEqualMetrics(prev, merged)) {
      if (nextMetricsByUuid === state.metricsByUuid) {
        nextMetricsByUuid = { ...state.metricsByUuid };
      }
      nextMetricsByUuid[uuid] = merged;
      touchedMetrics.add(uuid);
    }

    const prevTrend = state.trafficTrends[uuid] ?? EMPTY_TRAFFIC_TREND;
    const nextUp = updateTrafficTrendSeries(
      prevTrend.up,
      merged.netUp,
      merged.updatedAt,
      merged.online,
    );
    const nextDown = updateTrafficTrendSeries(
      prevTrend.down,
      merged.netDown,
      merged.updatedAt,
      merged.online,
    );

    if (nextUp.changed || nextDown.changed) {
      if (nextTrafficTrends === state.trafficTrends) {
        nextTrafficTrends = { ...state.trafficTrends };
      }
      nextTrafficTrends[uuid] = {
        up: nextUp.series,
        down: nextDown.series,
        snapshot: {
          up: nextUp.series.snapshot,
          down: nextDown.series.snapshot,
        },
      };
      touchedTrafficTrends.add(uuid);
    }
  }

  return {
    nextMetricsByUuid,
    nextTrafficTrends,
    touchedMetrics: [...touchedMetrics],
    touchedTrafficTrends: [...touchedTrafficTrends],
  };
}

function applyLatestStatusAndCommit(records: Record<string, unknown>) {
  if (Object.keys(records).length === 0) return;
  const applied = applyLatestStatus(records);
  const metricsChanged = applied.touchedMetrics.length > 0;
  const trafficTrendsChanged = applied.touchedTrafficTrends.length > 0;
  const storeStatusChanged = state.failureStreak > 0;

  if (metricsChanged || trafficTrendsChanged || storeStatusChanged) {
    commit(
      {
        ...state,
        metricsByUuid: metricsChanged ? applied.nextMetricsByUuid : state.metricsByUuid,
        trafficTrends: trafficTrendsChanged ? applied.nextTrafficTrends : state.trafficTrends,
        failureStreak: 0,
      },
      {
        metrics: applied.touchedMetrics,
        trafficTrends: applied.touchedTrafficTrends,
        storeStatus: storeStatusChanged,
      },
    );
  }
}

function applyNodeSnapshots(snapshots: NodeSnapshot[]) {
  const validSnapshots = snapshots.filter((snapshot) => snapshot.meta.uuid);
  if (validSnapshots.length === 0) return;

  const touchedMeta = new Set<string>();
  const touchedMetrics = new Set<string>();
  let nextMetaByUuid = state.metaByUuid;
  let nextMetricsByUuid = state.metricsByUuid;
  let nextOrder = state.order;
  let orderChanged = false;

  for (const { meta } of validSnapshots) {
    const uuid = meta.uuid;
    const previousMeta = state.metaByUuid[uuid];
    const isMetaUnchanged = previousMeta != null && shallowEqualNodeInfo(previousMeta, meta);
    const mergedMeta = isMetaUnchanged ? previousMeta : { ...meta };

    if (!isMetaUnchanged) {
      if (nextMetaByUuid === state.metaByUuid) nextMetaByUuid = { ...state.metaByUuid };
      nextMetaByUuid[uuid] = mergedMeta;
      touchedMeta.add(uuid);
    } else if (nextMetaByUuid !== state.metaByUuid) {
      nextMetaByUuid[uuid] = mergedMeta;
    }

    const previousMetrics = state.metricsByUuid[uuid];
    const nextMetrics = previousMetrics
      ? alignEmptyMetricsTotals(previousMetrics, meta)
      : emptyMetrics(meta, null);
    if (!previousMetrics || previousMetrics !== nextMetrics) {
      if (nextMetricsByUuid === state.metricsByUuid) {
        nextMetricsByUuid = { ...state.metricsByUuid };
      }
      nextMetricsByUuid[uuid] = nextMetrics;
      touchedMetrics.add(uuid);
    }

    if (!state.order.includes(uuid)) {
      nextOrder = [...nextOrder, uuid];
      orderChanged = true;
    }
  }

  if (orderChanged) {
    nextOrder = sortNodes(nextOrder.map((uuid) => nextMetaByUuid[uuid]).filter(Boolean)).map(
      (node) => node.uuid,
    );
  }

  const storeStatusChanged = !hydrated || nodeInfoError;
  hydrated = true;
  nodeInfoError = false;

  if (
    orderChanged ||
    touchedMeta.size > 0 ||
    touchedMetrics.size > 0 ||
    storeStatusChanged
  ) {
    commit(
      {
        ...state,
        order: nextOrder,
        metaByUuid: nextMetaByUuid,
        metricsByUuid: nextMetricsByUuid,
        trafficTrends: {
          ...state.trafficTrends,
          ...Object.fromEntries(
            nextOrder.map((uuid) => [uuid, state.trafficTrends[uuid] ?? EMPTY_TRAFFIC_TREND]),
          ),
        },
      },
      {
        meta: touchedMeta,
        metrics: touchedMetrics,
        nodeList: orderChanged,
        allNodes: orderChanged || touchedMeta.size > 0,
        storeStatus: storeStatusChanged,
      },
    );
  }

  applyLatestStatusAndCommit(
    Object.fromEntries(validSnapshots.map((snapshot) => [snapshot.meta.uuid, snapshot.latest])),
  );
}

let hydrated = false;
let nodeInfoError = false;
let homeNodeInfoPromise: Promise<void> | null = null;
let homeNodeInfoController: AbortController | null = null;
const nodeInfoPromises = new Map<string, Promise<void>>();
const nodeInfoControllers = new Map<string, AbortController>();

function sortNodes(nodes: NodeInfo[]) {
  return [...nodes].sort((left, right) => left.weight - right.weight);
}

function syncNodeInfo(uuid: string) {
  const cached = nodeInfoPromises.get(uuid);
  if (cached) return cached;
  const promise = performNodeInfoSync(uuid).finally(() => {
    nodeInfoPromises.delete(uuid);
  });
  nodeInfoPromises.set(uuid, promise);
  return promise;
}

function syncHomeNodeInfo() {
  homeNodeInfoPromise ??= performHomeNodeInfoSync().finally(() => {
    homeNodeInfoPromise = null;
  });
  return homeNodeInfoPromise;
}

async function performHomeNodeInfoSync() {
  const controller = new AbortController();
  homeNodeInfoController = controller;
  try {
    const snapshots = await getNodeSnapshots({ signal: controller.signal });
    if (controller.signal.aborted) return;
    if (snapshots.length > 0) {
      applyNodeSnapshots(snapshots);
    } else {
      hydrated = true;
      nodeInfoError = false;
      commit(state, { storeStatus: true, nodeList: true, allNodes: true });
    }
  } catch (error) {
    if (!controller.signal.aborted && !nodeInfoError) {
      nodeInfoError = true;
      commit(state, { storeStatus: true });
    }
    throw error;
  } finally {
    if (homeNodeInfoController === controller) homeNodeInfoController = null;
  }
}

async function performNodeInfoSync(uuid: string) {
  const controller = new AbortController();
  nodeInfoControllers.set(uuid, controller);
  try {
    const snapshot = await getNodeSnapshot(uuid, { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (snapshot) {
      applyNodeSnapshots([snapshot]);
    } else if (!hydrated || nodeInfoError) {
      hydrated = true;
      nodeInfoError = false;
      commit(state, { storeStatus: true });
    }
  } catch (error) {
    if (!controller.signal.aborted && !nodeInfoError) {
      nodeInfoError = true;
      commit(state, { storeStatus: true });
    }
    throw error;
  } finally {
    if (nodeInfoControllers.get(uuid) === controller) {
      nodeInfoControllers.delete(uuid);
    }
  }
}

async function bootstrap() {
  if (document.hidden) return;

  if (homeRetainCount > 0) {
    await syncHomeNodeInfo().catch(() => {});
  }

  const nodeUuids = getRetainedNodeUuids();
  if (nodeUuids.length > 0) {
    await Promise.allSettled(nodeUuids.map((uuid) => syncNodeInfo(uuid)));
  }

  startLiveSockets();
}

let started = false;
let retainCount = 0;
let homeRetainCount = 0;
const nodeRetainCounts = new Map<string, number>();
let stopTimer: number | null = null;
let liveSocketStops: Array<() => void> = [];

function handleVisibilityChange() {
  if (document.hidden) {
    closeLiveSockets();
    return;
  }
  void bootstrap();
}

function getJwtToken() {
  try {
    return localStorage.getItem("jwt_token") || "";
  } catch {
    return "";
  }
}

function closeLiveSockets() {
  for (const stop of liveSocketStops) stop();
  liveSocketStops = [];
}

function getRetainedNodeUuids() {
  return [...nodeRetainCounts].filter(([, count]) => count > 0).map(([uuid]) => uuid);
}

function buildLiveSocketUrl(baseUrl: string, subscribe: string) {
  const url = new URL(`${getWsBase(baseUrl)}/api/ws`);
  url.searchParams.set("subscribe", subscribe);
  const token = getJwtToken();
  if (token && url.host !== window.location.host) {
    url.searchParams.set("token", token);
  }
  return url;
}

function extractServerSnapshots(
  message: unknown,
  baseIndex: number,
  baseUrl: string,
): NodeSnapshot[] {
  const payload = asRecord(message);
  const servers = Array.isArray(message)
    ? message
    : Array.isArray(payload.servers)
      ? payload.servers
      : payload.server != null
        ? [payload.server]
        : [];

  return servers
    .map((server) => {
      const meta = mapServerToNodeInfo(server, baseIndex, baseUrl);
      return meta.uuid ? { meta, latest: mapServerToLatestRecord(server) } : null;
    })
    .filter((snapshot): snapshot is NodeSnapshot => Boolean(snapshot));
}

function mergeRealtimeRecordFrames(frames: Array<Record<string, unknown>>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const frame of frames) {
    for (const [serverId, record] of Object.entries(frame)) {
      merged[serverId] = {
        ...asRecord(merged[serverId]),
        ...asRecord(record),
      };
    }
  }
  return merged;
}

function extractRealtimeRecordFrames(message: unknown): Array<Record<string, unknown>> {
  const payload = asRecord(message);
  if (payload.type === "batchUpdate" && Array.isArray(payload.updates)) {
    const frames: Array<Record<string, unknown>> = [];
    for (const update of payload.updates) {
      const group = asRecord(update);
      const serverId = String(group.serverId || group.id || "");
      if (!serverId || !Array.isArray(group.samples)) continue;
      for (const sample of group.samples) {
        const item = asRecord(sample);
        const data = asRecord(item.data || item.payload || item.metrics);
        if (Object.keys(data).length === 0) continue;
        frames.push({
          [serverId]: {
            ...data,
            last_updated: item.ts || data.last_updated || payload.ts,
          },
        });
      }
    }
    return frames;
  }

  const serverId = String(payload.serverId || payload.id || "");
  const data = asRecord(payload.data || payload.payload || payload.metrics);
  if (serverId && Object.keys(data).length > 0) {
    return [{
      [serverId]: {
        ...data,
        last_updated: payload.ts || data.last_updated,
      },
    }];
  }

  return [];
}

function snapshotsFromUnknownRealtimeRecords(
  records: Record<string, unknown>,
  baseIndex: number,
  baseUrl: string,
): NodeSnapshot[] {
  return Object.entries(records)
    .filter(([uuid]) => !state.metaByUuid[uuid])
    .map(([uuid, record]) => {
      const server = { id: uuid, ...asRecord(record) };
      return {
        meta: mapServerToNodeInfo(server, baseIndex, baseUrl, uuid),
        latest: record as Record<string, unknown>,
      };
    });
}

function openLiveSocket(baseIndex: number, subscribe: string) {
  const apiBases = getApiBases();
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let stopped = false;

  const connect = () => {
    if (stopped || document.hidden) return;
    const baseUrl = apiBases[baseIndex] ?? apiBases[0] ?? window.location.origin;
    try {
      socket = new WebSocket(buildLiveSocketUrl(baseUrl, subscribe).toString());
    } catch {
      return;
    }

    socket.addEventListener("open", () => {
      if (!socket || stopped) return;
      socket.send(
        JSON.stringify(
          subscribe === "all"
            ? { type: "subscribe", scope: "all" }
            : { type: "subscribe", scope: "server", id: subscribe, ids: [subscribe] },
        ),
      );
    });

    socket.addEventListener("message", (event) => {
      if (stopped || typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      const recordFrames = extractRealtimeRecordFrames(message);
      const records = mergeRealtimeRecordFrames(recordFrames);
      applyNodeSnapshots([
        ...extractServerSnapshots(message, baseIndex, baseUrl),
        ...snapshotsFromUnknownRealtimeRecords(records, baseIndex, baseUrl),
      ]);
      for (const frame of recordFrames) {
        applyLatestStatusAndCommit(frame);
      }
    });

    socket.addEventListener("close", () => {
      socket = null;
      if (!stopped && !document.hidden) {
        reconnectTimer = window.setTimeout(connect, 5_000);
      }
    });
  };

  connect();
  liveSocketStops.push(() => {
    stopped = true;
    if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
  });
}

function startLiveSockets() {
  closeLiveSockets();
  const apiBases = getApiBases();

  if (homeRetainCount > 0) {
    apiBases.forEach((_, baseIndex) => openLiveSocket(baseIndex, "all"));
  }

  for (const uuid of getRetainedNodeUuids()) {
    const meta = state.metaByUuid[uuid] as (NodeInfo & { __cfsmBaseIndex?: number }) | undefined;
    if (typeof meta?.__cfsmBaseIndex === "number") {
      openLiveSocket(meta.__cfsmBaseIndex, uuid);
    } else {
      apiBases.forEach((_, baseIndex) => openLiveSocket(baseIndex, uuid));
    }
  }
}

function ensureStarted() {
  if (started) return;
  started = true;

  document.addEventListener("visibilitychange", handleVisibilityChange);
  void bootstrap();
}

function prepareRetain() {
  if (stopTimer != null) {
    window.clearTimeout(stopTimer);
    stopTimer = null;
  }
  retainCount += 1;
  ensureStarted();
}

function releaseRetain() {
  retainCount = Math.max(0, retainCount - 1);
  if (retainCount === 0 && stopTimer == null) {
    stopTimer = window.setTimeout(() => {
      stopTimer = null;
      if (retainCount === 0) stopStore();
    }, 0);
  }
}

export function retainHomeStore() {
  prepareRetain();
  const previousCount = homeRetainCount;
  homeRetainCount += 1;
  if (previousCount === 0) {
    void syncHomeNodeInfo().finally(() => {
      startLiveSockets();
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    homeRetainCount = Math.max(0, homeRetainCount - 1);
    if (homeRetainCount === 0) startLiveSockets();
    releaseRetain();
  };
}

export function retainNodeStore(uuid: string) {
  prepareRetain();
  const previousCount = nodeRetainCounts.get(uuid) ?? 0;
  nodeRetainCounts.set(uuid, previousCount + 1);
  if (previousCount === 0) {
    startLiveSockets();
    void syncNodeInfo(uuid).finally(() => {
      startLiveSockets();
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (nodeRetainCounts.get(uuid) ?? 1) - 1;
    if (count > 0) {
      nodeRetainCounts.set(uuid, count);
    } else {
      nodeRetainCounts.delete(uuid);
      nodeInfoControllers.get(uuid)?.abort();
      nodeInfoControllers.delete(uuid);
      startLiveSockets();
    }
    releaseRetain();
  };
}

export function retainStore() {
  return retainHomeStore();
}

function stopStore() {
  if (stopTimer != null) {
    window.clearTimeout(stopTimer);
    stopTimer = null;
  }
  for (const controller of nodeInfoControllers.values()) {
    controller.abort();
  }
  homeNodeInfoController?.abort();
  homeNodeInfoController = null;
  homeNodeInfoPromise = null;
  nodeInfoControllers.clear();
  nodeInfoPromises.clear();
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  closeLiveSockets();
  homeRetainCount = 0;
  nodeRetainCounts.clear();
  hydrated = false;
  nodeInfoError = false;
  started = false;
}

function subscribeSet(listeners: Set<Listener>, listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeVisibleNodeUuids(listener: Listener): () => void {
  return subscribeSet(visibleNodeListeners, listener);
}

export function subscribeAllNodes(listener: Listener): () => void {
  return subscribeSet(allNodesListeners, listener);
}

export function subscribeHomeNodeSummaries(listener: Listener): () => void {
  return subscribeSet(homeNodeSummaryListeners, listener);
}

export function subscribeNodeOnlineSummaries(listener: Listener): () => void {
  return subscribeSet(nodeOnlineSummaryListeners, listener);
}

export function subscribeStoreStatus(listener: Listener): () => void {
  return subscribeSet(storeStatusListeners, listener);
}

export function subscribeToNodeMeta(uuid: string, listener: Listener): () => void {
  return subscribeByKey(nodeMetaListeners, uuid, listener);
}

export function subscribeToNodeMetrics(uuid: string, listener: Listener): () => void {
  return subscribeByKey(nodeMetricsListeners, uuid, listener);
}

export function subscribeToNodeTrafficTrend(uuid: string, listener: Listener): () => void {
  return subscribeByKey(trafficTrendListeners, uuid, listener);
}

function subscribeByKey(
  listenersByKey: Map<string, Set<Listener>>,
  key: string,
  listener: Listener,
): () => void {
  let listeners = listenersByKey.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByKey.set(key, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) {
      listenersByKey.delete(key);
    }
  };
}

export function getStoreStatusSnapshot(): StoreStatusSnapshot {
  if (
    storeStatusSnapshot.failureStreak === state.failureStreak &&
    storeStatusSnapshot.hydrated === hydrated &&
    storeStatusSnapshot.nodeInfoError === nodeInfoError
  ) {
    return storeStatusSnapshot;
  }
  storeStatusSnapshot = {
    failureStreak: state.failureStreak,
    hydrated,
    nodeInfoError,
  };
  return storeStatusSnapshot;
}

export function getNodeMetaSnapshot(uuid: string): NodeInfo | undefined {
  return state.metaByUuid[uuid];
}

export function getNodeMetricsSnapshot(uuid: string): NodeMetrics | undefined {
  return state.metricsByUuid[uuid];
}

export function getNodeTrafficTrendSnapshot(uuid: string): {
  up: TrafficTrendSample[];
  down: TrafficTrendSample[];
} {
  const trend = state.trafficTrends[uuid] ?? EMPTY_TRAFFIC_TREND;
  return trend.snapshot;
}

export function getVisibleNodeUuidsSnapshot(includeHidden = false): string[] {
  if (includeHidden) {
    if (visibleNodeUuidsWithHiddenSnapshotVersion === storeVersion) {
      return visibleNodeUuidsWithHiddenSnapshot;
    }
  } else if (visibleNodeUuidsSnapshotVersion === storeVersion) {
    return visibleNodeUuidsSnapshot;
  }

  const next = state.order.filter((uuid) => {
    const node = state.metaByUuid[uuid];
    return Boolean(node) && (includeHidden || !node.hidden);
  });

  const previous = includeHidden
    ? visibleNodeUuidsWithHiddenSnapshot
    : visibleNodeUuidsSnapshot;
  const value =
    next.length === previous.length && next.every((uuid, index) => uuid === previous[index])
      ? previous
      : next;

  if (includeHidden) {
    visibleNodeUuidsWithHiddenSnapshot = value;
    visibleNodeUuidsWithHiddenSnapshotVersion = storeVersion;
  } else {
    visibleNodeUuidsSnapshot = value;
    visibleNodeUuidsSnapshotVersion = storeVersion;
  }
  return value;
}

export function getAllNodeMetaSnapshot(): NodeInfo[] {
  if (allNodeMetaSnapshotVersion === storeVersion) return allNodeMetaSnapshot;

  const next = state.order
    .map((uuid) => state.metaByUuid[uuid])
    .filter((node): node is NodeInfo => Boolean(node));

  if (
    !(
      next.length === allNodeMetaSnapshot.length &&
      next.every((node, index) => node === allNodeMetaSnapshot[index])
    )
  ) {
    allNodeMetaSnapshot = next;
  }
  allNodeMetaSnapshotVersion = storeVersion;
  return allNodeMetaSnapshot;
}

export function getHomeNodeSummariesSnapshot(): HomeNodeSummary[] {
  if (homeNodeSummariesSnapshotVersion === storeVersion) return homeNodeSummariesSnapshot;

  const next = state.order
    .map((uuid) => {
      const meta = state.metaByUuid[uuid];
      if (!meta) return null;
      const metrics = state.metricsByUuid[uuid];
      return {
        uuid,
        group: String(meta.group || "").trim(),
        region: String(meta.region || "").trim(),
        hidden: meta.hidden,
        weight: meta.weight,
        online: metrics?.online ?? null,
        trafficUp: metrics?.trafficUp ?? 0,
        trafficDown: metrics?.trafficDown ?? 0,
        netUp: metrics?.netUp ?? 0,
        netDown: metrics?.netDown ?? 0,
      };
    })
    .filter((item): item is HomeNodeSummary => Boolean(item));

  if (
    next.length === homeNodeSummariesSnapshot.length &&
    next.every((item, index) => {
      const prev = homeNodeSummariesSnapshot[index];
      return (
        prev &&
        prev.uuid === item.uuid &&
        prev.group === item.group &&
        prev.region === item.region &&
        prev.hidden === item.hidden &&
        prev.weight === item.weight &&
        prev.online === item.online &&
        prev.trafficUp === item.trafficUp &&
        prev.trafficDown === item.trafficDown &&
        prev.netUp === item.netUp &&
        prev.netDown === item.netDown
      );
    })
  ) {
    homeNodeSummariesSnapshotVersion = storeVersion;
    return homeNodeSummariesSnapshot;
  }

  homeNodeSummariesSnapshot = next;
  homeNodeSummariesSnapshotVersion = storeVersion;
  return homeNodeSummariesSnapshot;
}

export function getNodeOnlineSummariesSnapshot(): NodeOnlineSummary[] {
  if (nodeOnlineSummariesSnapshotVersion === nodeOnlineSummariesVersion) {
    return nodeOnlineSummariesSnapshot;
  }

  const next = state.order
    .filter((uuid) => Boolean(state.metaByUuid[uuid]))
    .map((uuid) => ({
      uuid,
      online: state.metricsByUuid[uuid]?.online ?? null,
    }));

  if (
    !(
      next.length === nodeOnlineSummariesSnapshot.length &&
      next.every((item, index) => {
        const previous = nodeOnlineSummariesSnapshot[index];
        return (
          previous?.uuid === item.uuid &&
          previous.online === item.online
        );
      })
    )
  ) {
    nodeOnlineSummariesSnapshot = next;
  }
  nodeOnlineSummariesSnapshotVersion = nodeOnlineSummariesVersion;
  return nodeOnlineSummariesSnapshot;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopStore();
  });
}
