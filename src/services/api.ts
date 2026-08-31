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

const DEFAULT_API_TIMEOUT_MS = 12_000;
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
const TURNSTILE_VERIFIED_KEY = "turnstile_verified";
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

function parseTrafficLimit(value: unknown) {
  if (typeof value === "number") return value;
  const input = asString(value).trim();
  const match = input.match(/^([\d.]+)\s*(b|kb|mb|gb|tb|pb)?$/i);
  if (!match) return asNumber(value);
  const amount = Number.parseFloat(match[1] ?? "0");
  const unit = (match[2] ?? "b").toLowerCase();
  const power = ["b", "kb", "mb", "gb", "tb", "pb"].indexOf(unit);
  return Number.isFinite(amount) && power >= 0 ? amount * 1024 ** power : 0;
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
    ipv4: asString(server.ip_v4),
    ipv6: asString(server.ip_v6),
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
    online: isOnline(server),
    ram_used: asNumber(server.ram_used) * 1024 * 1024,
    ram_total: asNumber(server.ram_total) * 1024 * 1024,
    swap_used: asNumber(server.swap_used) * 1024 * 1024,
    swap_total: asNumber(server.swap_total) * 1024 * 1024,
    disk_used: asNumber(server.disk_used) * 1024 * 1024,
    disk_total: asNumber(server.disk_total) * 1024 * 1024,
    net_total_up: asNumber(server.net_tx_monthly || server.net_tx),
    net_total_down: asNumber(server.net_rx_monthly || server.net_rx),
    net_out: asNumber(server.net_out_speed),
    net_in: asNumber(server.net_in_speed),
    process: asNumber(server.processes),
    connections: asNumber(server.tcp_conn),
    connections_udp: asNumber(server.udp_conn),
    updated_at: server.last_updated ?? server.timestamp,
  };
}

function rememberServerBase(uuid: string, baseIndex: number) {
  if (uuid) baseIndexByUuid.set(uuid, baseIndex);
}

function mapHistoryRow(row: unknown, uuid: string): LoadRecord {
  const record = asRecord(row);
  const [load1] = parseLoadValues(record.load_avg ?? record.load);
  return {
    cpu: asNumber(record.cpu),
    gpu: 0,
    ram: asNumber(record.ram_used) * 1024 * 1024,
    ram_total: asNumber(record.ram_total) * 1024 * 1024,
    swap: asNumber(record.swap_used) * 1024 * 1024,
    swap_total: asNumber(record.swap_total) * 1024 * 1024,
    load: load1,
    temp: 0,
    disk: asNumber(record.disk_used) * 1024 * 1024,
    disk_total: asNumber(record.disk_total) * 1024 * 1024,
    net_in: asNumber(record.net_in_speed),
    net_out: asNumber(record.net_out_speed),
    net_total_up: asNumber(record.net_tx_monthly || record.net_tx),
    net_total_down: asNumber(record.net_rx_monthly || record.net_rx),
    process: asNumber(record.processes),
    connections: asNumber(record.tcp_conn),
    connections_udp: asNumber(record.udp_conn),
    time: normalizeTimestamp(record.timestamp),
    client: uuid,
  };
}

function cfsmThemeDefaults(): Record<string, unknown> {
  return {
    showPingChart: false,
    enableHomepageMultiPing: false,
    fakePingForUnbound: false,
    showCostSummary: false,
    showCostSummaryFloatingButton: false,
    showTodayTrafficPopover: false,
    showConnections: true,
  };
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
  return {
    sitename: asString(data.site_title || document.title || "CF-Server-Monitor"),
    description: "CF-Server-Monitor theme.",
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
    theme_settings: {
      ...asRecord(data.theme_options),
      ...cfsmThemeDefaults(),
    },
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
  const results = await requestAll<{ servers?: unknown[] }>("/api/servers", options);
  return results.flatMap((result) =>
    (Array.isArray(result.data.servers) ? result.data.servers : [])
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
  const results = await requestAll<{ servers?: unknown[] }>("/api/servers", options);
  const records: Record<string, unknown> = {};
  for (const result of results) {
    for (const server of Array.isArray(result.data.servers) ? result.data.servers : []) {
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
  const path = `/api/history/all?${new URLSearchParams({ id: uuid, hours: String(safeHours) })}`;
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
  const records = results
    .flatMap((result) => (Array.isArray(result.data) ? result.data : []))
    .map((row) => mapHistoryRow(row, uuid))
    .filter((row) => asNumber(row.time) > 0)
    .sort((left, right) => asNumber(left.time) - asNumber(right.time));
  return {
    count: records.length,
    records,
    rangeStartMs: Date.now() - safeHours * 60 * 60 * 1000,
    rangeEndMs: Date.now(),
  };
}

export async function getPingRecords(
  _uuid?: string,
  _hours?: number,
  _options?: ApiCallOptions,
): Promise<PingRecordsResponse> {
  void _uuid;
  void _hours;
  void _options;
  return { count: 0, records: [], tasks: [] };
}

export async function getPingOverview(
  _hours?: number,
  _taskId?: number,
  _options?: ApiCallOptions & { entityIds?: string[]; includeStats?: boolean },
): Promise<{
  records: PingRecordsResponse["records"];
  tasks: PingTask[];
  intervalSeconds: number;
  stats?: PingTaskStats[];
}> {
  void _hours;
  void _taskId;
  void _options;
  return { records: [], tasks: [], intervalSeconds: 60, stats: [] };
}

export async function getPingOverviewStats(
  _hours?: number,
  _taskIds?: number[],
  _options?: ApiCallOptions & { entityIds?: string[] },
): Promise<PingTaskStats[]> {
  void _hours;
  void _taskIds;
  void _options;
  return [];
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
