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
] as const;

export const HOMEPAGE_CFSM_PROBE_DEFS = CFSM_PROBE_DEFS.filter(
  (def) => def.id === 1 || def.id === 2 || def.id === 3,
);

export function getCfsmProbeName(taskId: number) {
  return CFSM_PROBE_DEFS.find((def) => def.id === taskId)?.name ?? `任务 #${taskId}`;
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
