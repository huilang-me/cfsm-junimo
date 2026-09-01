import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { clearCssColorCache } from "@/components/node/CanvasStrip";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { saveThemeSettings } from "@/services/api";
import type { PublicConfig } from "@/types/cfsm";

export type MetricColorKey =
  | "cpu"
  | "memory"
  | "disk"
  | "load"
  | "swap"
  | "speedIdle"
  | "speedLow"
  | "speedHigh"
  | "speedMax"
  | "trafficUp"
  | "trafficDown";

type MetricColorGroup = "metric" | "speed" | "traffic";

export const METRIC_COLOR_GROUPS: ReadonlyArray<{ id: MetricColorGroup; label: string }> = [
  { id: "metric", label: "卡片配色" },
  { id: "speed", label: "速率热力" },
  { id: "traffic", label: "流量方向" },
];

export const METRIC_COLOR_META: ReadonlyArray<{
  key: MetricColorKey;
  label: string;
  cssVar: string;
  group: MetricColorGroup;
}> = [
  { key: "cpu", label: "CPU", cssVar: "--progress-cpu", group: "metric" },
  { key: "memory", label: "内存", cssVar: "--progress-memory", group: "metric" },
  { key: "disk", label: "磁盘", cssVar: "--progress-disk", group: "metric" },
  { key: "load", label: "负载", cssVar: "--progress-load", group: "metric" },
  { key: "swap", label: "Swap", cssVar: "--progress-swap", group: "metric" },
  { key: "speedIdle", label: "超低速", cssVar: "--speed-idle", group: "speed" },
  { key: "speedLow", label: "低速", cssVar: "--speed-low", group: "speed" },
  { key: "speedHigh", label: "高速", cssVar: "--speed-high", group: "speed" },
  { key: "speedMax", label: "急速", cssVar: "--speed-max", group: "speed" },
  { key: "trafficUp", label: "上行", cssVar: "--traffic-up", group: "traffic" },
  { key: "trafficDown", label: "下行", cssVar: "--traffic-down", group: "traffic" },
];

type MetricColors = Partial<Record<MetricColorKey, string>>;

const SETTINGS_KEY = "metricColors";
const HEX = /^#[0-9a-f]{6}$/;

function toInputHex(value: string): string {
  let v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) v = "#" + [...v.slice(1)].map((c) => c + c).join("");
  return HEX.test(v) ? v : "#888888";
}

function readMetricColorsFromSettings(
  settings: Record<string, unknown> | undefined,
): MetricColors {
  const raw = settings?.[SETTINGS_KEY];
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const out: MetricColors = {};
  for (const { key } of METRIC_COLOR_META) {
    const v = source[key];
    if (typeof v === "string" && HEX.test(v.toLowerCase())) out[key] = v.toLowerCase();
  }
  return out;
}

let version = 0;
let appliedSig = "__init__";
let rafId: number | null = null;
const listeners = new Set<() => void>();

let metricColorEditing = false;

function bumpVersionThrottled() {
  if (rafId != null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    version += 1;
    for (const l of listeners) l();
  });
}

function applyMetricColors(colors: MetricColors) {
  const sig = JSON.stringify(colors ?? {});
  if (sig === appliedSig) return;
  appliedSig = sig;
  const root = document.documentElement;
  for (const { key, cssVar } of METRIC_COLOR_META) {
    const v = colors[key];
    if (v) root.style.setProperty(cssVar, v);
    else root.style.removeProperty(cssVar);
  }
  clearCssColorCache();
  bumpVersionThrottled();
}

export function useMetricColorsVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => version,
    () => version,
  );
}

export function readEffectiveColors(): Record<MetricColorKey, string> {
  const styles = getComputedStyle(document.documentElement);
  const out = {} as Record<MetricColorKey, string>;
  for (const { key, cssVar } of METRIC_COLOR_META) out[key] = toInputHex(styles.getPropertyValue(cssVar));
  return out;
}

export function useMetricColorsSync() {
  const { data: config } = usePublicConfig();
  const colors = useMemo(
    () => (config ? readMetricColorsFromSettings(config.theme_settings) : null),
    [config],
  );
  useEffect(() => {
    if (!colors) return;
    if (metricColorEditing) return;
    applyMetricColors(colors);
  }, [colors]);
}

export function useMetricColorsEditor() {
  const { data: config } = usePublicConfig();
  const queryClient = useQueryClient();
  const serverColors = useMemo(
    () => readMetricColorsFromSettings(config?.theme_settings),
    [config?.theme_settings],
  );

  const [draft, setDraft] = useState<MetricColors>(serverColors);
  const [saveError, setSaveError] = useState(false);
  const draftRef = useRef<MetricColors>(serverColors);
  const saveTimer = useRef<number | null>(null);
  const serverColorsRef = useRef<MetricColors>(serverColors);
  const pendingColorsRef = useRef<MetricColors | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const hasQueuedRef = useRef(false);
  const queuedColorsRef = useRef<MetricColors>({});

  useEffect(() => {
    if (metricColorEditing) return;
    if (JSON.stringify(serverColorsRef.current) === JSON.stringify(serverColors)) return;
    serverColorsRef.current = serverColors;
    draftRef.current = serverColors;
    setDraft(serverColors);
  }, [serverColors]);

  const finishEditing = useCallback((restoreSaved = false) => {
    metricColorEditing = false;
    if (restoreSaved) applyMetricColors(serverColorsRef.current);
  }, []);

  const persist = useCallback(
    async (colors: MetricColors) => {
      if (!config) {
        if (!mountedRef.current) finishEditing(true);
        return;
      }
      if (inFlightRef.current) {
        queuedColorsRef.current = colors;
        hasQueuedRef.current = true;
        return;
      }
      inFlightRef.current = true;
      let current = colors;
      let lastOk = false;
      let savedAny = false;
      try {
        for (;;) {
          const latest = queryClient.getQueryData<PublicConfig>(["public"]) ?? config;
          const nextSettings: Record<string, unknown> = { ...(latest.theme_settings ?? {}) };
          if (Object.keys(current).length > 0) nextSettings[SETTINGS_KEY] = current;
          else delete nextSettings[SETTINGS_KEY];
          try {
            await saveThemeSettings(latest.theme, nextSettings);
            lastOk = true;
            savedAny = true;
            serverColorsRef.current = current;
            if (mountedRef.current) setSaveError(false);
          } catch {
            lastOk = false;
            if (mountedRef.current) setSaveError(true);
          }
          if (!hasQueuedRef.current) break;
          hasQueuedRef.current = false;
          current = queuedColorsRef.current;
        }
      } finally {
        inFlightRef.current = false;
      }
      const hasPendingSave = pendingColorsRef.current != null || saveTimer.current != null;
      if (lastOk && !hasPendingSave) {
        finishEditing();
      } else if (!mountedRef.current) {
        finishEditing(true);
      }
      if (savedAny) {
        void queryClient.invalidateQueries({ queryKey: ["public"] });
      }
    },
    [config, finishEditing, queryClient],
  );

  const persistRef = useRef(persist);
  useEffect(() => {
    persistRef.current = persist;
  }, [persist]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveTimer.current != null) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (pendingColorsRef.current != null) {
        void persistRef.current(pendingColorsRef.current);
        pendingColorsRef.current = null;
      } else if (!inFlightRef.current) {
        finishEditing(true);
      }
    };
  }, [finishEditing]);

  const scheduleSave = useCallback(
    (colors: MetricColors) => {
      if (!config) return;
      if (saveTimer.current != null) clearTimeout(saveTimer.current);
      pendingColorsRef.current = colors;
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        pendingColorsRef.current = null;
        void persist(colors);
      }, 500);
    },
    [config, persist],
  );

  const commit = useCallback(
    (next: MetricColors) => {
      metricColorEditing = true;
      draftRef.current = next;
      setDraft(next);
      applyMetricColors(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );

  const setColor = useCallback(
    (key: MetricColorKey, hex: string) => {
      const v = hex.toLowerCase();
      if (HEX.test(v)) {
        commit({ ...draftRef.current, [key]: v });
      }
    },
    [commit],
  );

  const resetColor = useCallback(
    (key: MetricColorKey) => {
      const colors = { ...draftRef.current };
      delete colors[key];
      commit(colors);
    },
    [commit],
  );

  const resetAll = useCallback(() => commit({}), [commit]);

  return {
    colors: draft,
    setColor,
    resetColor,
    resetAll,
    saveError,
  };
}
