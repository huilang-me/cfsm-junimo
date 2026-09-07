export const CFSM_PROBE_DEFS = [
  {
    id: 1,
    name: "电信",
    type: "ct",
    windowKey: "ct",
    pingField: "ping_ct",
    lossField: "loss_ct",
    metricsPingKey: "pingCt",
    metricsLossKey: "lossCt",
  },
  {
    id: 2,
    name: "联通",
    type: "cu",
    windowKey: "cu",
    pingField: "ping_cu",
    lossField: "loss_cu",
    metricsPingKey: "pingCu",
    metricsLossKey: "lossCu",
  },
  {
    id: 3,
    name: "移动",
    type: "cm",
    windowKey: "cm",
    pingField: "ping_cm",
    lossField: "loss_cm",
    metricsPingKey: "pingCm",
    metricsLossKey: "lossCm",
  },
  {
    id: 4,
    name: "BGP",
    type: "bgp",
    windowKey: "bd",
    pingField: "ping_bd",
    lossField: "loss_bd",
    metricsPingKey: "pingBd",
    metricsLossKey: "lossBd",
  },
  ...([1, 2, 3, 4] as const).map((node) => ({
    id: 4 + node,
    name: `Node ${node}`,
    type: `node_${node}`,
    windowKey: `node_${node}`,
    pingField: `ping_node_${node}`,
    lossField: `loss_node_${node}`,
    metricsPingKey: `pingNode${node}`,
    metricsLossKey: `lossNode${node}`,
  })),
] as const;

const DEFAULT_CFSM_PROBE_NAMES = Object.fromEntries(
  CFSM_PROBE_DEFS.map((def) => [def.id, def.name]),
) as Record<number, string>;
let customCfsmProbeNames: Partial<Record<number, string>> = {};

/** Apply names returned by /api/config; empty/missing values keep legacy names. */
export function setCfsmProbeNames(names: {
  custom_ct_name?: unknown;
  custom_cu_name?: unknown;
  custom_cm_name?: unknown;
  custom_bd_name?: unknown;
}) {
  const entries: Array<[number, unknown]> = [
    [1, names.custom_ct_name],
    [2, names.custom_cu_name],
    [3, names.custom_cm_name],
    [4, names.custom_bd_name],
  ];
  customCfsmProbeNames = Object.fromEntries(
    entries
      .map(([id, value]) => [id, typeof value === "string" ? value.trim() : ""] as const)
      .filter(([, value]) => value.length > 0),
  );
}

export function getConfiguredCfsmProbeName(taskId: number) {
  return customCfsmProbeNames[taskId];
}

export const HOMEPAGE_CFSM_PROBE_DEFS = CFSM_PROBE_DEFS.filter(
  (def) => def.id === 1 || def.id === 2 || def.id === 3,
);

export function getCfsmProbeName(taskId: number) {
  return customCfsmProbeNames[taskId] ?? DEFAULT_CFSM_PROBE_NAMES[taskId] ?? `任务 #${taskId}`;
}

export function isDisabledProbeMetric(value: unknown) {
  return value === false || String(value ?? "").trim().toLowerCase() === "false";
}

export function parseProbeMetricValue(value: unknown): number | null {
  if (
    value == null ||
    value === "" ||
    String(value).trim().toLowerCase() === "null" ||
    isDisabledProbeMetric(value)
  ) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function clampLossPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

export function parseGpuInfoList(value: unknown): Array<{ id?: unknown; name?: unknown; info?: unknown }> {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
  } catch {
    return [];
  }
}

export function parseGpuUtil(value: unknown): number | null {
  const utils = parseGpuInfoList(value)
    .map((gpu) => Number.parseFloat(String(gpu.info ?? "")))
    .filter((util) => Number.isFinite(util));
  if (utils.length === 0) return null;
  return Math.max(...utils);
}
