import type {
  AdminClient,
  LoadRecord,
  LoadRecordsResponse,
  Me,
  NodeInfo,
  PingRecordsResponse,
  PingTask,
  PingTaskStats,
  PublicConfig,
} from "@/types/cfsm";
import {
  CFSM_PROBE_DEFS,
  HOMEPAGE_CFSM_PROBE_DEFS,
  clampLossPercent,
  parseProbeMetricValue,
} from "@/utils/cfsmProbeMetrics";

const DEFAULT_API_TIMEOUT_MS = 12_000;
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
const TURNSTILE_VERIFIED_KEY = "turnstile_verified";
const HOMEPAGE_LATENCY_WINDOW_POINTS = 20;
const HOMEPAGE_LATENCY_WINDOW_HOURS = 2;
const baseIndexByUuid = new Map<string, number>();

interface ApiCallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

interface CfsmRequestOptions extends ApiCallOptions {
  baseIndex?: number;
  includeAuth?: boolean;
  includeTurnstile?: boolean;
  autoRedirect?: boolean;
}

interface LoadRecordsOptions extends ApiCallOptions {
  skipMetricQuery?: boolean;
}

interface CfsmFetchResult<T> {
  data: T;
  baseUrl: string;
  baseIndex: number;
}

interface HomepageLatencyWindowConfig {
  points: number;
  hours: number;
}

interface HomepagePingSnapshot extends PingRecordsResponse {
  windowConfig: HomepageLatencyWindowConfig;
}

export interface InstanceHistoryResponse {
  load: LoadRecordsResponse;
  ping: PingRecordsResponse;
}

interface ServersPayload {
  servers?: unknown[];
  latestMetricsMap?: unknown;
  sysConfig?: unknown;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function warnDegradedOnce(key: string, message: string) {
  const store = (warnDegradedOnce as { warned?: Set<string> }).warned ??= new Set<string>();
  if (store.has(key)) return;
  store.add(key);
  console.warn(`[cfsm-junimo] ${message}`);
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function getApiBases(): string[] {
  const metaApiBase = document.querySelector<HTMLMetaElement>('meta[name="apiBase"]')?.content;
  const bases = metaApiBase
    ?.split(",")
    .map((item) => stripTrailingSlash(item.trim()))
    .filter(Boolean);
  return bases && bases.length > 0 ? bases : [stripTrailingSlash(window.location.origin)];
}

export function getWsBase(baseUrl: string) {
  const url = new URL(baseUrl || window.location.origin, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${url.protocol}//${url.host}`;
}

function getJwtToken() {
  try {
    return localStorage.getItem("jwt_token") || "";
  } catch {
    return "";
  }
}

function buildHeaders(options: CfsmRequestOptions = {}) {
  const includeAuth = options.includeAuth !== false;
  const includeTurnstile = options.includeTurnstile !== false;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (includeAuth) {
    const token = getJwtToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  if (includeTurnstile) {
    const turnstileToken = localStorage.getItem("turnstile_token");
    const turnstileVerified = localStorage.getItem(TURNSTILE_VERIFIED_KEY);
    if (turnstileToken) headers["X-Turnstile-Token"] = turnstileToken;
    if (turnstileVerified) headers["X-Turnstile-Verified"] = turnstileVerified;
  }

  return headers;
}

function redirectToAdmin() {
  if (window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/")) {
    window.location.reload();
    return;
  }
  window.location.assign("/admin#admin");
}

async function requestJson<T>(
  path: string,
  options: CfsmRequestOptions = {},
): Promise<CfsmFetchResult<T>> {
  const bases = getApiBases();
  const baseIndex = options.baseIndex ?? 0;
  const baseUrl = bases[baseIndex] ?? bases[0] ?? stripTrailingSlash(window.location.origin);
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
    options.timeout ?? DEFAULT_API_TIMEOUT_MS,
  );

  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      credentials: "include",
      headers: buildHeaders(options),
      signal: controller.signal,
    });

    if (response.status === 401) {
      localStorage.removeItem("jwt_token");
      if (options.autoRedirect !== false) redirectToAdmin();
    }
    if (response.status === 403) {
      localStorage.removeItem("turnstile_token");
      localStorage.removeItem(TURNSTILE_VERIFIED_KEY);
    }
    if (!response.ok) {
      let message = `Request ${path} failed: ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string; message?: string };
        message = body.error || body.message || message;
      } catch {
        // Keep the status-based fallback.
      }
      throw new ApiRequestError(message, response.status, path);
    }

    return {
      data: (await response.json()) as T,
      baseUrl,
      baseIndex,
    };
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function requestAll<T>(
  path: string,
  options: CfsmRequestOptions = {},
): Promise<Array<CfsmFetchResult<T>>> {
  const bases = getApiBases();
  const settled = await Promise.allSettled(
    bases.map((_, baseIndex) =>
      requestJson<T>(path, { ...options, baseIndex, autoRedirect: false }),
    ),
  );
  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function asString(value: unknown, fallback = "") {
  if (value == null) return fallback;
  return String(value);
}

function asBool(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return !["", "0", "false", "no", "off"].includes(value.toLowerCase());
  }
  return false;
}

function hasOwn(source: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function normalizeTimestamp(value: unknown) {
  const number = asNumber(value);
  if (number > 0) return number > 1_000_000_000_000 ? number : number * 1000;
  const parsed = Date.parse(asString(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseLoadValues(value: unknown): [number, number, number] {
  if (Array.isArray(value)) {
    return [asNumber(value[0]), asNumber(value[1]), asNumber(value[2])];
  }
  const parts = asString(value).trim().split(/\s+/);
  return [asNumber(parts[0]), asNumber(parts[1]), asNumber(parts[2])];
}

function normalizeProbeField(payload: Record<string, unknown>, key: string) {
  return hasOwn(payload, key) ? parseProbeMetricValue(payload[key]) : null;
}

function normalizeLatencyWindowConfig(value: unknown): HomepageLatencyWindowConfig {
  const record = asRecord(value);
  const rawPoints = asNumber(record.points, HOMEPAGE_LATENCY_WINDOW_POINTS);
  const rawHours = asNumber(record.hours, HOMEPAGE_LATENCY_WINDOW_HOURS);
  const points = Number.isInteger(rawPoints) && rawPoints > 0
    ? Math.min(240, rawPoints)
    : HOMEPAGE_LATENCY_WINDOW_POINTS;
  const hours = Number.isFinite(rawHours) && rawHours > 0
    ? Math.min(168, rawHours)
    : HOMEPAGE_LATENCY_WINDOW_HOURS;
  return { points, hours };
}

function extractServersFromPayload(data: ServersPayload | Record<string, unknown>) {
  const payload = asRecord(data);
  if (Array.isArray(payload.servers)) return payload.servers;
  return Object.entries(asRecord(payload.latestMetricsMap)).map(([id, metrics]) => ({
    id,
    ...asRecord(metrics),
  }));
}

function parseTrafficLimit(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value * 1024 ** 3 : 0;
  const input = asString(value).trim();
  const match = input.match(/^([\d.]+)\s*(b|kb|mb|gb|tb|pb)?$/i);
  if (!match) return asNumber(value);
  const amount = Number.parseFloat(match[1] ?? "0");
  const unit = (match[2] ?? "gb").toLowerCase();
  const power = ["b", "kb", "mb", "gb", "tb", "pb"].indexOf(unit);
  return Number.isFinite(amount) && power >= 0 ? amount * 1024 ** power : 0;
}

function parseIpStackFlag(value: unknown) {
  const normalized = asString(value).trim().toLowerCase();
  if (!normalized || normalized === "0" || normalized === "false" || normalized === "no") {
    return "";
  }
  return normalized;
}

function pickMonthlyTrafficUp(record: Record<string, unknown>) {
  return hasOwn(record, "net_tx_monthly") ? asNumber(record.net_tx_monthly) : asNumber(record.net_tx);
}

function pickMonthlyTrafficDown(record: Record<string, unknown>) {
  return hasOwn(record, "net_rx_monthly") ? asNumber(record.net_rx_monthly) : asNumber(record.net_rx);
}

function pickLifetimeTrafficUp(record: Record<string, unknown>) {
  return hasOwn(record, "net_tx") ? asNumber(record.net_tx) : pickMonthlyTrafficUp(record);
}

function pickLifetimeTrafficDown(record: Record<string, unknown>) {
  return hasOwn(record, "net_rx") ? asNumber(record.net_rx) : pickMonthlyTrafficDown(record);
}

function parseGpuName(value: unknown) {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (!raw || raw === "null") return "";
  try {
    const parsed = JSON.parse(raw) as Array<{ name?: string }>;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => item.name).filter(Boolean).join(", ");
    }
  } catch {
    // Fall back to the original value.
  }
  return raw;
}

function isOnline(server: Record<string, unknown>, now = Date.now()) {
  const ts = normalizeTimestamp(server.report_timestamp ?? server.last_updated ?? server.timestamp);
  return ts > 0 && now - ts < ONLINE_THRESHOLD_MS;
}

export function mapServerToNodeInfo(
  rawServer: unknown,
  baseIndex = 0,
  baseUrl = "",
  fallbackId = "",
): NodeInfo & { __cfsmBaseIndex?: number; __cfsmBaseUrl?: string } {
  const server = asRecord(rawServer);
  return {
    uuid: asString(server.id, fallbackId),
    name: asString(server.name, asString(server.id, fallbackId)),
    group: asString(server.server_group, "Default"),
    region: asString(server.region).toUpperCase(),
    hidden: asBool(server.is_hidden),
    cpu_name: asString(server.cpu_info),
    cpu_cores: asNumber(server.cpu_cores),
    arch: asString(server.arch),
    virtualization: "",
    os: asString(server.os),
    kernel_version: asString(server.kernel_version),
    gpu_name: parseGpuName(server.gpu_info),
    mem_total: asNumber(server.ram_total) * 1024 * 1024,
    swap_total: asNumber(server.swap_total) * 1024 * 1024,
    disk_total: asNumber(server.disk_total) * 1024 * 1024,
    weight: asNumber(server.sort_order),
    price: asNumber(server.price),
    billing_cycle: asString(server.billing_cycle),
    auto_renewal: asBool(server.auto_renewal),
    currency: asString(server.currency),
    expired_at: asString(server.expire_date),
    tags: asString(server.tags),
    public_remark: "",
    traffic_limit: parseTrafficLimit(server.traffic_limit),
    traffic_limit_type: asString(server.traffic_calc_type || "total"),
    ipv4: parseIpStackFlag(server.ip_v4),
    ipv6: parseIpStackFlag(server.ip_v6),
    created_at: "",
    updated_at: asString(server.last_updated ?? server.timestamp),
    __cfsmBaseIndex: baseIndex,
    __cfsmBaseUrl: baseUrl,
  };
}

export function mapServerToLatestRecord(rawServer: unknown): Record<string, unknown> {
  const server = asRecord(rawServer);
  return {
    ...server,
    __cfsmServerSnapshot: true,
    online: isOnline(server),
    ram_used: asNumber(server.ram_used) * 1024 * 1024,
    ram_total: asNumber(server.ram_total) * 1024 * 1024,
    swap_used: asNumber(server.swap_used) * 1024 * 1024,
    swap_total: asNumber(server.swap_total) * 1024 * 1024,
    disk_used: asNumber(server.disk_used) * 1024 * 1024,
    disk_total: asNumber(server.disk_total) * 1024 * 1024,
    net_total_up: pickMonthlyTrafficUp(server),
    net_total_down: pickMonthlyTrafficDown(server),
    net_lifetime_up: pickLifetimeTrafficUp(server),
    net_lifetime_down: pickLifetimeTrafficDown(server),
    net_out: asNumber(server.net_out_speed),
    net_in: asNumber(server.net_in_speed),
    process: asNumber(server.processes),
    connections: asNumber(server.tcp_conn),
    connections_udp: asNumber(server.udp_conn),
    boot_time: server.boot_time,
    updated_at: server.last_updated ?? server.timestamp,
  };
}

function rememberServerBase(uuid: string, baseIndex: number) {
  if (uuid) baseIndexByUuid.set(uuid, baseIndex);
}

function mapHistoryRow(row: unknown, uuid: string): LoadRecord {
  const record = asRecord(row);
  const [load1, load5, load15] = parseLoadValues(record.load_avg ?? record.load);
  return {
    cpu: asNumber(record.cpu),
    gpu: 0,
    ram: asNumber(record.ram_used) * 1024 * 1024,
    ram_total: asNumber(record.ram_total) * 1024 * 1024,
    swap: asNumber(record.swap_used) * 1024 * 1024,
    swap_total: asNumber(record.swap_total) * 1024 * 1024,
    load: load1,
    load5,
    load15,
    temp: 0,
    disk: asNumber(record.disk_used) * 1024 * 1024,
    disk_total: asNumber(record.disk_total) * 1024 * 1024,
    net_in: asNumber(record.net_in_speed),
    net_out: asNumber(record.net_out_speed),
    net_total_up: pickMonthlyTrafficUp(record),
    net_total_down: pickMonthlyTrafficDown(record),
    process: asNumber(record.processes),
    connections: asNumber(record.tcp_conn),
    connections_udp: asNumber(record.udp_conn),
    gpu_info: record.gpu_info,
    disk_read_bps: asNumber(record.disk_read_bps),
    disk_write_bps: asNumber(record.disk_write_bps),
    disk_read_iops: asNumber(record.disk_read_iops),
    disk_write_iops: asNumber(record.disk_write_iops),
    disk_await_ms: asNumber(record.disk_await_ms),
    disk_util: asNumber(record.disk_util),
    time: normalizeTimestamp(record.timestamp),
    client: uuid,
  };
}

function cfsmThemeDefaults(): Record<string, unknown> {
  return {
    defaultAppearance: "farm",
    showPingChart: true,
    enableHomepageMultiPing: true,
    homepageMultiPingTaskIds: [1, 2, 3],
    homepageMultiPingGroups: [{ taskIds: [1, 2, 3], clientUuids: [] }],
    fakePingForUnbound: false,
    showCostSummary: false,
    showCostSummaryFloatingButton: false,
    showTodayTrafficPopover: false,
    showConnections: true,
  };
}

function cfsmHomepageMultiPingGroups(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    return [{ taskIds: [1, 2, 3], clientUuids: [] }];
  }

  return value
    .filter((group) => group && typeof group === "object" && !Array.isArray(group))
    .map((group) => ({
      ...(group as Record<string, unknown>),
      taskIds: [1, 2, 3],
    }));
}

export async function getConfig(options?: ApiCallOptions): Promise<Record<string, unknown>> {
  const { data } = await requestJson<Record<string, unknown>>("/api/config", {
    ...options,
    includeTurnstile: false,
    autoRedirect: false,
  });
  return data;
}

export function mapConfigToMe(config: Record<string, unknown>): Me {
  const authorized = config.authorization === true;
  return {
    logged_in: authorized,
    username: authorized ? "admin" : "",
    uuid: authorized ? "cfsm-admin" : "",
  };
}

export function mapConfigToPublic(data: Record<string, unknown>): PublicConfig {
  const themeOptions = asRecord(data.theme_options);
  const themeSettings = {
    ...cfsmThemeDefaults(),
    ...themeOptions,
    enableHomepageMultiPing: true,
    homepageMultiPingTaskIds: [1, 2, 3],
    homepageMultiPingGroups: cfsmHomepageMultiPingGroups(themeOptions.homepageMultiPingGroups),
  };

  return {
    sitename: asString(data.site_title || document.title || "CF-Server-Monitor"),
    description: "CF-Server-Monitor theme.",
    version: asString(data.version),
    theme: "cfsm-junimo",
    allow_cors: true,
    disable_password_login: false,
    oauth_enable: false,
    private_site: data.is_public === false,
    record_enabled: true,
    record_preserve_time: 168,
    ping_record_preserve_time: 0,
    metric_retention_days: asNumber(asRecord(data.long_history_config).days),
    custom_head: "",
    custom_body: "",
    theme_settings: themeSettings,
  };
}

export async function getMe(options?: ApiCallOptions): Promise<Me> {
  return mapConfigToMe(await getConfig(options));
}

export async function getPublic(options?: ApiCallOptions): Promise<PublicConfig> {
  return mapConfigToPublic(await getConfig(options));
}

export async function getNodes(options?: ApiCallOptions): Promise<NodeInfo[]> {
  return (await getNodeSnapshots(options)).map((snapshot) => snapshot.meta);
}

export async function getNodeSnapshots(
  options?: ApiCallOptions,
): Promise<Array<{ meta: NodeInfo; latest: Record<string, unknown> }>> {
  const results = await requestAll<ServersPayload>("/api/servers", options);
  return results.flatMap((result) =>
    extractServersFromPayload(result.data)
      .map((server) => {
        const meta = mapServerToNodeInfo(server, result.baseIndex, result.baseUrl);
        rememberServerBase(meta.uuid, result.baseIndex);
        return {
          meta,
          latest: mapServerToLatestRecord(server),
        };
      })
      .filter((snapshot) => snapshot.meta.uuid),
  );
}

function extractServerPayload(data: unknown): unknown | null {
  const payload = asRecord(data);
  if (payload.server != null) return payload.server;
  if (Array.isArray(payload.servers)) return payload.servers[0] ?? null;
  if (Object.keys(payload).length > 0) return data;
  return null;
}

export async function getNodeSnapshot(
  uuid: string,
  options?: ApiCallOptions,
): Promise<{ meta: NodeInfo; latest: Record<string, unknown> } | null> {
  const path = `/api/server?${new URLSearchParams({ id: uuid })}`;
  const knownBaseIndex = baseIndexByUuid.get(uuid);
  const results =
    typeof knownBaseIndex === "number"
      ? [
          await requestJson<unknown>(path, {
            ...options,
            baseIndex: knownBaseIndex,
            autoRedirect: false,
          }),
        ]
      : await requestAll<unknown>(path, { ...options, autoRedirect: false });

  for (const result of results) {
    const server = extractServerPayload(result.data);
    if (server == null) continue;
    const meta = mapServerToNodeInfo(server, result.baseIndex, result.baseUrl, uuid);
    if (!meta.uuid || meta.uuid !== uuid) continue;
    rememberServerBase(meta.uuid, result.baseIndex);
    return {
      meta,
      latest: mapServerToLatestRecord(server),
    };
  }

  return null;
}

export async function getNodesLatestStatus(
  uuids?: string[],
  options?: ApiCallOptions,
): Promise<Record<string, unknown>> {
  const wanted = uuids && uuids.length > 0 ? new Set(uuids) : null;
  const results = await requestAll<ServersPayload>("/api/servers", options);
  const records: Record<string, unknown> = {};
  for (const result of results) {
    for (const server of extractServersFromPayload(result.data)) {
      const id = asString(asRecord(server).id);
      if (!id || (wanted && !wanted.has(id))) continue;
      rememberServerBase(id, result.baseIndex);
      records[id] = mapServerToLatestRecord(server);
    }
  }
  return records;
}

export async function getLoadRecords(
  uuid: string,
  hours = 6,
  options?: LoadRecordsOptions,
): Promise<LoadRecordsResponse> {
  const safeHours = hours > 0 ? hours : 1;
  const rows = await fetchHistoryRows(uuid, safeHours, options);
  return buildLoadHistoryResponse(uuid, safeHours, rows);
}

function getCfsmProbeTask(taskId: number): PingTask | null {
  const def = CFSM_PROBE_DEFS.find((item) => item.id === taskId);
  if (!def) return null;
  return {
    id: def.id,
    interval: 60,
    name: def.name,
    loss: 0,
    clients: [],
    type: def.type,
    target: "",
    weight: def.id,
  };
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return null;
  const index = (values.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower] ?? null;
  const lowerValue = values[lower] ?? 0;
  const upperValue = values[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function buildPingStats(uuid: string, task: PingTask, records: PingRecordsResponse["records"]): PingTaskStats {
  const successful = records
    .map((record) => record.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const total = records.reduce((sum, record) => sum + Math.max(1, Math.round(record.count ?? 1)), 0);
  const lost = records.reduce((sum, record) => {
    const count = Math.max(1, Math.round(record.count ?? 1));
    const loss = typeof record.loss === "number" && Number.isFinite(record.loss)
      ? clampLossPercent(record.loss)
      : record.value != null && record.value < 0
        ? 100
        : 0;
    return sum + (loss / 100) * count;
  }, 0);
  const latest =
    [...records].reverse().find(
      (record) => typeof record.value === "number" && record.value >= 0,
    )?.value ?? null;
  const avg = successful.length
    ? successful.reduce((sum, value) => sum + value, 0) / successful.length
    : null;
  const p50 = percentile(successful, 0.5);
  const p99 = percentile(successful, 0.99);

  return {
    client: uuid,
    taskId: task.id,
    name: task.name,
    type: task.type,
    interval: task.interval,
    total,
    valid: Math.max(0, Math.round(total - lost)),
    loss: total > 0 ? (lost / total) * 100 : task.loss,
    min: successful[0] ?? null,
    max: successful[successful.length - 1] ?? null,
    avg,
    latest,
    p50,
    p99,
    stddev: null,
    p99P50Ratio: p50 && p99 ? Math.max(0, p99 - p50) / Math.min(50, Math.max(10, p50)) : 0,
  };
}

async function getCfsmPingRecordsForNodes(
  uuids: string[],
  hours: number,
  options?: ApiCallOptions,
): Promise<PingRecordsResponse> {
  const safeHours = hours > 0 ? hours : 0.167;
  const responses = await Promise.all(
    uuids.map(async (uuid) => {
      const rows = await fetchHistoryRows(uuid, safeHours, options);
      return { uuid, rows };
    }),
  );

  const records = responses
    .flatMap(({ uuid, rows }) =>
      rows.flatMap((row) => {
        const record = asRecord(row);
        const time = normalizeTimestamp(record.timestamp);
        if (time <= 0) return [];
        return CFSM_PROBE_DEFS.flatMap((def) => {
          const value = normalizeProbeField(record, def.pingField);
          const loss = normalizeProbeField(record, def.lossField);
          if (value == null && loss == null) return [];
          return [{
            task_id: def.id,
            time,
            value: value ?? -1,
            client: uuid,
            count: 1,
            loss: loss == null ? (value == null ? 100 : 0) : clampLossPercent(loss),
          }];
        });
      }),
    )
    .sort((left, right) => asNumber(left.time) - asNumber(right.time));
  const observedTaskIds = new Set(records.map((record) => record.task_id));
  const tasks = CFSM_PROBE_DEFS
    .filter((def) => observedTaskIds.has(def.id))
    .map((def) => ({
      ...getCfsmProbeTask(def.id)!,
      clients: uuids,
    }));
  const stats = responses.flatMap(({ uuid }) =>
    tasks.map((task) =>
      buildPingStats(
        uuid,
        task,
        records.filter((record) => record.client === uuid && record.task_id === task.id),
      ),
    ),
  );

  return {
    count: records.length,
    records,
    tasks,
    stats,
    rangeStartMs: Date.now() - safeHours * 60 * 60 * 1000,
    rangeEndMs: Date.now(),
    intervalSeconds: 60,
  };
}

async function fetchHistoryRows(
  uuid: string,
  hours: number,
  options?: ApiCallOptions,
): Promise<unknown[]> {
  const path = `/api/history/all?${new URLSearchParams({ id: uuid, hours: String(hours) })}`;
  const knownBaseIndex = baseIndexByUuid.get(uuid);
  const results =
    typeof knownBaseIndex === "number"
      ? [
          await requestJson<unknown[]>(path, {
            ...options,
            baseIndex: knownBaseIndex,
            autoRedirect: false,
          }),
        ]
      : await requestAll<unknown[]>(path, { ...options, autoRedirect: false });
  return results.flatMap((result) => (Array.isArray(result.data) ? result.data : []));
}

function buildLoadHistoryResponse(
  uuid: string,
  hours: number,
  rows: unknown[],
): LoadRecordsResponse {
  const records = rows
    .map((row) => mapHistoryRow(row, uuid))
    .filter((row) => asNumber(row.time) > 0)
    .sort((left, right) => asNumber(left.time) - asNumber(right.time));
  return {
    count: records.length,
    records,
    rangeStartMs: Date.now() - hours * 60 * 60 * 1000,
    rangeEndMs: Date.now(),
  };
}

function buildPingHistoryResponse(
  uuid: string,
  hours: number,
  rows: unknown[],
): PingRecordsResponse {
  const records = rows
    .flatMap((row) => {
      const record = asRecord(row);
      const time = normalizeTimestamp(record.timestamp);
      if (time <= 0) return [];
      return CFSM_PROBE_DEFS.flatMap((def) => {
        const value = normalizeProbeField(record, def.pingField);
        const loss = normalizeProbeField(record, def.lossField);
        if (value == null && loss == null) return [];
        return [{
          task_id: def.id,
          time,
          value: value ?? -1,
          client: uuid,
          count: 1,
          loss: loss == null ? (value == null ? 100 : 0) : clampLossPercent(loss),
        }];
      });
    })
    .sort((left, right) => asNumber(left.time) - asNumber(right.time));
  const observedTaskIds = new Set(records.map((record) => record.task_id));
  const tasks = CFSM_PROBE_DEFS
    .filter((def) => observedTaskIds.has(def.id))
    .map((def) => ({
      ...getCfsmProbeTask(def.id)!,
      clients: [uuid],
    }));
  const stats = tasks.map((task) =>
    buildPingStats(
      uuid,
      task,
      records.filter((record) => record.task_id === task.id),
    ),
  );
  return {
    count: records.length,
    records,
    tasks,
    stats,
    rangeStartMs: Date.now() - hours * 60 * 60 * 1000,
    rangeEndMs: Date.now(),
    intervalSeconds: 60,
  };
}

export async function getInstanceHistory(
  uuid: string,
  hours = 6,
  options?: ApiCallOptions,
): Promise<InstanceHistoryResponse> {
  const safeHours = hours > 0 ? hours : 0.167;
  const rows = await fetchHistoryRows(uuid, safeHours, options);
  return {
    load: buildLoadHistoryResponse(uuid, safeHours, rows),
    ping: buildPingHistoryResponse(uuid, safeHours, rows),
  };
}

function readLatencyWindowValue(point: unknown, ...keys: string[]) {
  const record = asRecord(point);
  for (const key of keys) {
    if (!hasOwn(record, key)) continue;
    const value = parseProbeMetricValue(record[key]);
    if (value != null) return value;
  }
  return null;
}

function timestampedWindowPoints(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((point) => {
      const record = asRecord(point);
      const time = normalizeTimestamp(record.ts ?? record.time ?? record.timestamp);
      return time > 0 ? { time, point } : null;
    })
    .filter((item): item is { time: number; point: unknown } => item !== null)
    .sort((left, right) => left.time - right.time);
}

function readLatestWindowValue(value: unknown, ...keys: string[]) {
  const points = timestampedWindowPoints(value);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const current = readLatencyWindowValue(points[index]?.point, ...keys);
    if (current != null) return current;
  }
  return null;
}

function buildHomepagePingRecord(
  uuid: string,
  taskId: number,
  time: number,
  latency: number | null,
  loss: number | null,
): PingRecordsResponse["records"][number] | null {
  if (time <= 0) return null;
  return {
    task_id: taskId,
    time,
    value: latency,
    client: uuid,
    count: 1,
    loss: loss == null ? null : clampLossPercent(loss),
  };
}

function buildHomepagePingRecordsForServer(server: Record<string, unknown>, uuid: string) {
  const pingWindow = timestampedWindowPoints(server.ping);
  const lossWindow = timestampedWindowPoints(server.loss);
  const pingByTime = new Map(pingWindow.map((item) => [item.time, item.point] as const));
  const lossByTime = new Map(lossWindow.map((item) => [item.time, item.point] as const));
  const times = Array.from(
    new Set([...pingByTime.keys(), ...lossByTime.keys()]),
  ).sort((left, right) => left - right);
  const records: PingRecordsResponse["records"] = [];

  for (const time of times) {
    const pingPoint = pingByTime.get(time);
    const lossPoint = lossByTime.get(time);
    for (const def of HOMEPAGE_CFSM_PROBE_DEFS) {
      const record = buildHomepagePingRecord(
        uuid,
        def.id,
        time,
        readLatencyWindowValue(pingPoint, def.windowKey, def.pingField),
        readLatencyWindowValue(lossPoint, def.windowKey, def.lossField),
      );
      if (record) records.push(record);
    }
  }

  return records;
}

function getHomepagePingPointCount(server: Record<string, unknown>) {
  return Math.max(
    Array.isArray(server.ping) ? server.ping.length : 0,
    Array.isArray(server.loss) ? server.loss.length : 0,
  );
}

function withHomepagePingLatestFallback(
  stat: PingTaskStats,
  server: Record<string, unknown>,
  task: PingTask,
) {
  const def = CFSM_PROBE_DEFS.find((item) => item.id === task.id);
  if (!def) return stat;
  const latest =
    readLatestWindowValue(server.ping, def.windowKey, def.pingField) ??
    normalizeProbeField(server, def.pingField);
  const loss =
    readLatestWindowValue(server.loss, def.windowKey, def.lossField) ??
    normalizeProbeField(server, def.lossField);
  if (stat.total > 0) {
    return {
      ...stat,
      latest: stat.latest ?? latest,
      loss: loss ?? stat.loss ?? task.loss,
    };
  }

  return {
    ...stat,
    loss: loss ?? task.loss,
    min: latest,
    max: latest,
    avg: latest,
    latest,
    p50: latest,
    p99: latest,
  };
}

async function loadCfsmHomepagePingSnapshot(
  entityIds: string[],
  options?: ApiCallOptions,
): Promise<HomepagePingSnapshot> {
  const wanted = new Set(entityIds.filter(Boolean));
  const serverResults = await requestAll<ServersPayload>("/api/servers", {
    ...options,
    autoRedirect: false,
  });
  const firstServerWindow = serverResults
    .map((result) => asRecord(result.data.sysConfig).latency_window)
    .find((value) => Object.keys(asRecord(value)).length > 0);
  const windowConfig = normalizeLatencyWindowConfig(firstServerWindow);
  const records: PingRecordsResponse["records"] = [];
  const serverEntries: Array<{ uuid: string; server: Record<string, unknown> }> = [];
  let snapshotEndMs = 0;
  let snapshotPointCount = 0;

  for (const result of serverResults) {
    for (const rawServer of extractServersFromPayload(result.data)) {
      const server = asRecord(rawServer);
      const uuid = asString(server.id);
      if (!uuid || (wanted.size > 0 && !wanted.has(uuid))) continue;
      rememberServerBase(uuid, result.baseIndex);
      serverEntries.push({ uuid, server });
      const serverNow = normalizeTimestamp(server.current_timestamp ?? server.timestamp ?? server.last_updated);
      if (serverNow > snapshotEndMs) snapshotEndMs = serverNow;
      snapshotPointCount = Math.max(snapshotPointCount, getHomepagePingPointCount(server));
      records.push(...buildHomepagePingRecordsForServer(server, uuid));
    }
  }

  records.sort((left, right) => asNumber(left.time) - asNumber(right.time));
  const tasks = HOMEPAGE_CFSM_PROBE_DEFS
    .map((def) => ({
      ...getCfsmProbeTask(def.id)!,
      clients: entityIds,
    }));
  const stats = serverEntries.flatMap(({ uuid, server }) =>
    tasks.map((task) =>
      withHomepagePingLatestFallback(
        buildPingStats(
          uuid,
          task,
          records.filter((record) => record.client === uuid && record.task_id === task.id),
        ),
        server,
        task,
      ),
    ),
  );
  const windowMs = windowConfig.hours * 60 * 60 * 1000;
  const rangeEndMs = snapshotEndMs > 0 ? snapshotEndMs : Date.now();
  const intervalSeconds = Math.max(1, (windowConfig.hours * 60 * 60) / windowConfig.points);

  return {
    count: records.length,
    records,
    tasks,
    stats,
    rangeStartMs: rangeEndMs - windowMs,
    rangeEndMs,
    windowMs,
    pointCount: snapshotPointCount > 0 ? snapshotPointCount : windowConfig.points,
    intervalSeconds,
    windowConfig,
  };
}

async function getCfsmHomepagePingSnapshot(
  entityIds: string[],
  options?: ApiCallOptions,
): Promise<HomepagePingSnapshot> {
  return loadCfsmHomepagePingSnapshot(entityIds, options);
}

export async function getPingRecords(
  uuid: string,
  hours = 6,
  options?: ApiCallOptions,
): Promise<PingRecordsResponse> {
  return getCfsmPingRecordsForNodes(uuid ? [uuid] : [], hours, options);
}

export async function getPingOverview(
  _hours = 1,
  taskId?: number,
  options?: ApiCallOptions & { entityIds?: string[]; includeStats?: boolean },
): Promise<{
  records: PingRecordsResponse["records"];
  tasks: PingTask[];
  intervalSeconds: number;
  windowMs?: number;
  rangeEndMs?: number;
  pointCount?: number;
  stats?: PingTaskStats[];
}> {
  void _hours;
  const entityIds = options?.entityIds ?? [];
  const data = await getCfsmHomepagePingSnapshot(entityIds, options);
  const records = taskId == null
    ? data.records
    : data.records.filter((record) => record.task_id === taskId);
  const tasks = taskId == null
    ? data.tasks
    : data.tasks.filter((task) => task.id === taskId);
  const stats = taskId == null
    ? data.stats
    : data.stats?.filter((stat) => stat.taskId === taskId);
  return {
    records,
    tasks,
    intervalSeconds: data.intervalSeconds ?? 60,
    windowMs: data.windowMs,
    rangeEndMs: data.rangeEndMs,
    pointCount: data.pointCount,
    stats: options?.includeStats === false ? undefined : stats,
  };
}

export async function getPingOverviewStats(
  _hours = 1,
  taskIds: number[] = [],
  options?: ApiCallOptions & { entityIds?: string[] },
): Promise<PingTaskStats[]> {
  void _hours;
  const wantedTaskIds = new Set(taskIds);
  const data = await getCfsmHomepagePingSnapshot(options?.entityIds ?? [], options);
  return (data.stats ?? []).filter((stat) => wantedTaskIds.has(stat.taskId));
}

export function prewarmPingOverviewDependencies() {
  return undefined;
}

export async function getAdminClients(options?: ApiCallOptions): Promise<AdminClient[]> {
  return getNodes(options);
}

export async function getAdminPingTasks(): Promise<PingTask[]> {
  return [];
}

export async function saveThemeSettings(
  _theme?: string,
  _settings?: Record<string, unknown>,
): Promise<void> {
  void _theme;
  void _settings;
  warnDegradedOnce("theme-settings", "CFSM 主题暂不提供当前主题管理保存接口");
}
