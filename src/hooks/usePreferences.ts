import { useSyncExternalStore } from "react";
import type { ResolvedAppearance } from "@/utils/background";
import type { Appearance, FarmScene } from "@/utils/themeSettings";

const FARM_DAY_START_HOUR = 6;
const FARM_DAY_END_HOUR = 18;
const FIXED_APPEARANCE: Appearance = "farm";

export function farmSceneOf(date: Date = new Date()): FarmScene {
  const hour = date.getHours();
  return hour >= FARM_DAY_START_HOUR && hour < FARM_DAY_END_HOUR ? "day" : "dusk";
}

export type FarmSeason = "spring" | "summer" | "autumn" | "winter";

export function farmSeasonOf(date: Date = new Date()): FarmSeason {
  const month = date.getMonth();
  if (month >= 2 && month <= 4) return "spring";
  if (month >= 5 && month <= 7) return "summer";
  if (month >= 8 && month <= 10) return "autumn";
  return "winter";
}

function msUntilNextFarmBoundary(now: Date = new Date()): number {
  const hour = now.getHours();
  const nextHour =
    hour < FARM_DAY_START_HOUR
      ? FARM_DAY_START_HOUR
      : hour < FARM_DAY_END_HOUR
        ? FARM_DAY_END_HOUR
        : 24 + FARM_DAY_START_HOUR;
  const next = new Date(now);
  next.setHours(nextHour, 0, 1, 0);
  return next.getTime() - now.getTime();
}

interface PrefsState {
  appearance: Appearance;
  resolvedAppearance: ResolvedAppearance;
  farmScene: FarmScene;
}

function getFarmState(): PrefsState {
  return {
    appearance: FIXED_APPEARANCE,
    resolvedAppearance: FIXED_APPEARANCE,
    farmScene: farmSceneOf(),
  };
}

const listeners = new Set<() => void>();
let snapshot: PrefsState = getFarmState();
let farmSceneTimer: number | null = null;
let listenersAttached = false;

function emit() {
  for (const l of listeners) l();
}

function applyFarmAppearance(state: PrefsState) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.appearance = FIXED_APPEARANCE;
  root.dataset.farmScene = state.farmScene;
  root.dataset.farmSeason = farmSeasonOf();
  root.style.colorScheme = "light";

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = state.farmScene === "dusk" ? "#2c2450" : "#63b4e6";
  }
}

function scheduleFarmSceneTimer() {
  if (farmSceneTimer != null) {
    window.clearTimeout(farmSceneTimer);
    farmSceneTimer = null;
  }
  if (typeof window === "undefined") return;
  farmSceneTimer = window.setTimeout(refreshFarmAppearance, msUntilNextFarmBoundary());
}

function refreshFarmAppearance() {
  const next = getFarmState();
  const changed = snapshot.farmScene !== next.farmScene;
  snapshot = next;
  applyFarmAppearance(snapshot);
  scheduleFarmSceneTimer();
  if (changed) emit();
}

function handleVisibilityChange() {
  if (!document.hidden) refreshFarmAppearance();
}

function attachListeners() {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  window.addEventListener("focus", refreshFarmAppearance);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  scheduleFarmSceneTimer();
}

function detachListeners() {
  if (!listenersAttached || typeof window === "undefined") return;
  listenersAttached = false;
  if (farmSceneTimer != null) {
    window.clearTimeout(farmSceneTimer);
    farmSceneTimer = null;
  }
  window.removeEventListener("focus", refreshFarmAppearance);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
}

if (typeof document !== "undefined") {
  applyFarmAppearance(snapshot);
}

function subscribe(l: () => void) {
  const wasEmpty = listeners.size === 0;
  listeners.add(l);
  if (wasEmpty) attachListeners();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) detachListeners();
  };
}

function getSnapshot() {
  return snapshot;
}

export function usePreferences() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return {
    appearance: state.appearance,
    resolvedAppearance: state.resolvedAppearance,
    farmScene: state.farmScene,
  };
}
