import { useEffect, useMemo, useRef, useState } from "react";
import UplotReact from "uplot-react";
import type uPlot from "uplot";
import { Eye, EyeOff } from "lucide-react";
import { InstancePanel, InstanceChartLoading } from "./InstancePanel";
import {
  buildChartTooltipHooks,
  colorForSeries,
  createTimeAxisFormatter,
  getAxisColors,
  toChartSeconds,
  useResponsiveChartSize,
  type ChartTooltipState,
} from "./chartShared";
import { ChartTooltip, SwitchToggle } from "./ChartParts";
import {
  cutPeakValues,
  detectTypicalIntervalSeconds,
  downsampleAligned,
  insertMetricGapSentinels,
  smoothByCount,
} from "./chartData";
import { latencyHeatColor, lossHeatColor } from "@/utils/metricTone";
import { historyCoverageLabel } from "@/utils/historyRange";
import { resolvePingChartInterval, resolvePingSampleCounts } from "@/utils/pingMetrics";
import { useNodeMetrics } from "@/hooks/useNode";
import { CFSM_PROBE_DEFS, clampLossPercent } from "@/utils/cfsmProbeMetrics";
import type { NodeMetrics, PingRecord, PingRecordsResponse, PingTask, PingTaskStats } from "@/types/cfsm";
import type { TimedMetricPoint } from "./chartData";

interface WeightedLatency {
  value: number;
  weight: number;
}

function valueAtWeightedIndex(sorted: WeightedLatency[], index: number) {
  let offset = 0;
  for (const sample of sorted) {
    offset += sample.weight;
    if (index < offset) return sample.value;
  }
  return sorted[sorted.length - 1]?.value ?? null;
}

function percentileFromWeighted(sorted: WeightedLatency[], ratio: number) {
  const total = sorted.reduce((sum, sample) => sum + sample.weight, 0);
  if (total <= 0) return null;
  const index = (total - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = valueAtWeightedIndex(sorted, lower);
  const upperValue = valueAtWeightedIndex(sorted, upper);
  if (lowerValue == null || upperValue == null) return null;
  if (lower === upper) return lowerValue;
  const weight = index - lower;
  return lowerValue + (upperValue - lowerValue) * weight;
}

export function summarizePingRecords(records: PingRecord[]) {
  const samples = records.map((record) => ({
    record,
    ...resolvePingSampleCounts(record),
  }));
  const valid = samples
    .filter(
      ({ record, valid: count }) =>
        typeof record.value === "number" &&
        Number.isFinite(record.value) &&
        record.value >= 0 &&
        count > 0,
    )
    .map(({ record, valid: count }) => ({ value: record.value as number, weight: count }))
    .sort((a, b) => a.value - b.value);
  const total = samples.reduce((sum, sample) => sum + sample.total, 0);
  const lost = samples.reduce((sum, sample) => sum + sample.lost, 0);
  const validCount = valid.reduce((sum, sample) => sum + sample.weight, 0);

  let latest: number | null = null;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const { record, valid: count } = samples[index];
    if (
      typeof record.value === "number" &&
      Number.isFinite(record.value) &&
      record.value >= 0 &&
      count > 0
    ) {
      latest = record.value;
      break;
    }
  }

  return {
    latest,
    avg:
      validCount > 0
        ? valid.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / validCount
        : null,
    min: valid[0]?.value ?? null,
    max: valid[valid.length - 1]?.value ?? null,
    p50: percentileFromWeighted(valid, 0.5),
    p99: percentileFromWeighted(valid, 0.99),
    total,
    lost,
    loss: total > 0 ? (lost / total) * 100 : 0,
  };
}

const EMPTY_PING_STATS: PingTaskStats[] = [];
const MAX_RENDER_POINTS = 160;
const REALTIME_WINDOW_SECONDS = 10 * 60;
const REALTIME_RECORD_LIMIT = 2400;
// 1 即关闭平滑(smoothByCount 对 <=1 原样返回);保留常量便于调参,非削峰模式当前不平滑。
const SMOOTH_WINDOW_POINTS = 1;
const SMOOTH_WINDOW_POINTS_PEAK = 13;

function realtimeRecordsFromNode(node: NodeMetrics, uuid: string): PingRecord[] {
  const time = node.updatedAt > 0 ? node.updatedAt : Date.now();
  return CFSM_PROBE_DEFS.flatMap((def) => {
    const latency = node[def.metricsPingKey];
    const loss = node[def.metricsLossKey];
    if (latency == null && loss == null) return [];
    return [{
      task_id: def.id,
      time,
      value: latency ?? -1,
      client: uuid,
      count: 1,
      loss: loss == null ? (latency == null ? 100 : 0) : clampLossPercent(loss),
    }];
  });
}

type PingMetric = "latency" | "loss";

function PingMetricFigure({
  uuid,
  hours,
  metric,
  title,
  sortedRecords,
  tasks,
  taskLabels,
  taskColors,
  taskKeySet,
  taskKeys,
  taskIndexById,
  visibleTasks,
  hiddenTasks,
  data,
  requestedXRange,
  connectNulls,
  cutPeak,
}: {
  uuid: string;
  hours: number;
  metric: PingMetric;
  title: string;
  sortedRecords: Array<{ record: PingRecord; time: number }>;
  tasks: PingTask[];
  taskLabels: Map<number, string>;
  taskColors: Map<number, string>;
  taskKeySet: Set<string>;
  taskKeys: string[];
  taskIndexById: Map<number, number>;
  visibleTasks: PingTask[];
  hiddenTasks: Set<number>;
  data: PingRecordsResponse | undefined;
  requestedXRange: [number, number] | null | undefined;
  connectNulls: boolean;
  cutPeak: boolean;
}) {
  const { w, h, ref: chartSizeRef } = useResponsiveChartSize("wide");
  const chartRef = useRef<uPlot.AlignedData>([[]]);
  const [tooltip, setTooltip] = useState<ChartTooltipState>({
    show: false,
    left: 0,
    top: 0,
    rows: [],
    time: "",
  });
  const isLoss = metric === "loss";

  const chart = useMemo(() => {
    if (!sortedRecords.length || !tasks.length) return null;
    const pointMap = new Map<number, TimedMetricPoint>();
    const taskIntervals = tasks
      .map((task) => task.interval)
      .filter((value): value is number => typeof value === "number" && value > 0);
    const detectedInterval = detectTypicalIntervalSeconds(
      sortedRecords.map(({ time }) => time),
      60,
    );
    const fallbackInterval = resolvePingChartInterval(
      data?.intervalSeconds,
      taskIntervals.length > 0 ? Math.min(...taskIntervals) : null,
      detectedInterval,
    );
    const tolerance = Math.min(6, Math.max(0.8, fallbackInterval * 0.25));

    let lastAnchor = Number.NEGATIVE_INFINITY;
    for (const { record, time } of sortedRecords) {
      if (!taskKeySet.has(String(record.task_id))) continue;
      const anchor = time - lastAnchor <= tolerance ? lastAnchor : time;
      if (anchor === time) lastAnchor = time;
      const current = pointMap.get(anchor) ?? { time: anchor };
      current[String(record.task_id)] = isLoss
        ? typeof record.loss === "number" && Number.isFinite(record.loss)
          ? clampLossPercent(record.loss)
          : record.value != null && record.value < 0
            ? 100
            : null
        : typeof record.value === "number" && record.value >= 0
          ? record.value
          : null;
      pointMap.set(anchor, current);
    }

    let chartPoints = [...pointMap.values()].sort((a, b) => a.time - b.time);
    if (!isLoss && cutPeak && taskKeys.length > 0) {
      chartPoints = cutPeakValues(chartPoints, taskKeys);
    }
    chartPoints = insertMetricGapSentinels(chartPoints, {
      intervals: new Map(
        tasks.map((task) => [
          String(task.id),
          resolvePingChartInterval(data?.intervalSeconds, task.interval, fallbackInterval),
        ] as const),
      ),
      defaultInterval: fallbackInterval,
      matchToleranceRatio: 0.25,
    });
    const times = chartPoints.map((point) => point.time);
    const perTask = taskKeys.map((taskKey) =>
      chartPoints.map((point) => point[taskKey]),
    );
    const reduced = downsampleAligned(times, perTask, MAX_RENDER_POINTS, isLoss || !cutPeak);
    const smoothed = smoothByCount(
      reduced.perTask,
      !isLoss && cutPeak ? SMOOTH_WINDOW_POINTS_PEAK : SMOOTH_WINDOW_POINTS,
    );

    return [reduced.times, ...smoothed] as uPlot.AlignedData;
  }, [cutPeak, data, isLoss, sortedRecords, taskKeySet, taskKeys, tasks]);

  useEffect(() => {
    if (chart) chartRef.current = chart;
  }, [chart]);

  const hasChart = Boolean(chart);
  const baseOptions = useMemo<Omit<uPlot.Options, "width" | "height"> | null>(() => {
    if (!hasChart) return null;
    const { grid, text } = getAxisColors();
    const tooltipHooks = buildChartTooltipHooks({
      dataRef: chartRef,
      rangeHours: hours,
      estimatedWidth: 196,
      setTooltip,
      buildRows: (idx) =>
        visibleTasks
          .map((task) => {
            const taskIndex = taskIndexById.get(task.id) ?? 0;
            const raw = chartRef.current[taskIndex + 1]?.[idx] as number | null | undefined;
            return {
              label: taskLabels.get(task.id) ?? `任务 #${task.id}`,
              raw: typeof raw === "number" && Number.isFinite(raw) ? raw : null,
              color: taskColors.get(task.id) ?? colorForSeries(taskIndex, tasks.length),
            };
          })
          .sort((a, b) => {
            if (a.raw == null) return b.raw == null ? 0 : 1;
            if (b.raw == null) return -1;
            return b.raw - a.raw;
          })
          .map(({ label, raw, color }) => ({
            label,
            value: raw == null ? "—" : isLoss ? `${raw.toFixed(1)}%` : `${raw.toFixed(1)} ms`,
            color,
          })),
    });
    return {
      padding: [10, 14, 12, 2],
      cursor: { drag: { x: true, y: false } },
      legend: { show: false },
      scales: {
        x: requestedXRange
          ? { time: true, auto: false, range: () => requestedXRange }
          : { time: true },
        y: isLoss ? { auto: false, range: () => [0, 100] as [number, number] } : { auto: true },
      },
      axes: [
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          size: 36,
          values: createTimeAxisFormatter(hours),
        },
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          size: 54,
          values: (_self, splits) =>
            splits.map((value) =>
              value === 0 ? "" : isLoss ? `${Math.round(value)}%` : `${Math.round(value)} ms`,
            ),
        },
      ],
      series: [
        { label: "time" },
        ...tasks.map((task, index) => ({
          label: taskLabels.get(task.id) ?? `任务 #${task.id}`,
          stroke: taskColors.get(task.id) ?? colorForSeries(index, tasks.length),
          width: 1.7,
          spanGaps: connectNulls,
          show: !hiddenTasks.has(task.id),
          points: { show: false },
        })),
      ],
      hooks: {
        init: [
          (u) => {
            u.root.setAttribute("role", "img");
            u.root.setAttribute("aria-label", `Ping ${title}历史图表，共 ${tasks.length} 条线路`);
          },
          tooltipHooks.onInit,
        ],
        destroy: [tooltipHooks.onDestroy],
        setCursor: [tooltipHooks.onSetCursor],
      },
    };
  }, [connectNulls, hasChart, hiddenTasks, hours, isLoss, requestedXRange, taskColors, taskIndexById, taskLabels, tasks, title, visibleTasks]);

  const options = useMemo<uPlot.Options | null>(
    () => (baseOptions ? { ...baseOptions, width: w, height: h } : null),
    [baseOptions, w, h],
  );

  return (
    <section className="instance-ping-figure" aria-label={`Ping ${title}`}>
      <div className="instance-panel-subhead">{title}</div>
      <div ref={chartSizeRef} className="instance-uplot-wrap is-large">
        {chart && options && visibleTasks.length > 0 ? (
          <>
            <UplotReact
              key={`${uuid}-${hours}-${metric}-${cutPeak ? "smooth" : "raw"}-${connectNulls ? "span" : "gap"}`}
              options={options}
              data={chart}
            />
            <ChartTooltip tooltip={tooltip} />
          </>
        ) : (
          <div className="instance-empty">当前已隐藏全部线路，点击上方按钮可恢复显示</div>
        )}
      </div>
    </section>
  );
}

export function PingChart({
  uuid,
  hours,
  active = true,
  historyQuery,
}: {
  uuid: string;
  hours: number;
  active?: boolean;
  historyQuery: {
    data?: PingRecordsResponse;
    isError: boolean;
    isFetching: boolean;
    isLoading: boolean;
    refetch: () => void;
  };
}) {
  const isRealtime = hours === 0;
  const {
    data,
    isError,
    isFetching,
    isLoading,
    refetch: refetchRecords,
  } = historyQuery;
  // stats 随详情历史同一次请求返回,不再单独发起 Ping 查询。
  const pingStats = data?.stats ?? EMPTY_PING_STATS;
  const node = useNodeMetrics(uuid, isRealtime && active, "node");
  const [hiddenTasks, setHiddenTasks] = useState<Set<number>>(new Set());
  const [connectNulls, setConnectNulls] = useState(false);
  const [cutPeak, setCutPeak] = useState(false);
  const [realtimeRecords, setRealtimeRecords] = useState<PingRecord[]>([]);
  const realtimeTaskIdsKey = useMemo(() => {
    if ((data?.tasks?.length ?? 0) > 0 || !isRealtime || realtimeRecords.length === 0) return "";
    return Array.from(new Set(realtimeRecords.map((record) => record.task_id)))
      .sort((left, right) => left - right)
      .join(",");
  }, [data?.tasks?.length, isRealtime, realtimeRecords]);
  // API 顺序与后台任务权重一致，响应本身不一定包含可重排的权重。
  const tasks = useMemo(() => {
    const baseTasks = data?.tasks ?? [];
    if (baseTasks.length > 0 || !isRealtime || !realtimeTaskIdsKey) {
      return [...baseTasks];
    }
    const observedTaskIds = new Set(
      realtimeTaskIdsKey
        .split(",")
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value)),
    );
    return CFSM_PROBE_DEFS
      .filter((def) => observedTaskIds.has(def.id))
      .map((def) => ({
        id: def.id,
        interval: 60,
        name: def.name,
        loss: 0,
        clients: [uuid],
        type: def.type,
        target: "",
        weight: def.id,
      }));
  }, [data?.tasks, isRealtime, realtimeTaskIdsKey, uuid]);
  const taskLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const label = task.name || `任务 #${task.id}`;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return new Map(
      tasks.map((task) => {
        const baseLabel = task.name || `任务 #${task.id}`;
        const label = (counts.get(baseLabel) ?? 0) > 1 ? `${baseLabel} #${task.id}` : baseLabel;
        return [task.id, label] as const;
      }),
    );
  }, [tasks]);
  const taskColors = useMemo(
    () => new Map(tasks.map((task, index) => [task.id, colorForSeries(index, tasks.length)] as const)),
    [tasks],
  );
  const taskKeySet = useMemo(() => new Set(tasks.map((task) => String(task.id))), [tasks]);
  const taskKeys = useMemo(() => tasks.map((task) => String(task.id)), [tasks]);
  const taskIndexById = useMemo(
    () => new Map(tasks.map((task, index) => [task.id, index] as const)),
    [tasks],
  );
  const visibleTasks = useMemo(
    () => tasks.filter((task) => !hiddenTasks.has(task.id)),
    [hiddenTasks, tasks],
  );

  useEffect(() => {
    setHiddenTasks(new Set());
  }, [uuid]);

  useEffect(() => {
    if (!active || !isRealtime || !node) return;
    const nextRecords = realtimeRecordsFromNode(node, uuid);
    if (nextRecords.length === 0) return;
    setRealtimeRecords((prev) => {
      const merged = [...prev, ...nextRecords].sort(
        (left, right) => toChartSeconds(left.time) - toChartSeconds(right.time),
      );
      const deduped = merged.filter((record, index, arr) => {
        const next = arr[index + 1];
        return !next ||
          record.task_id !== next.task_id ||
          Math.abs(toChartSeconds(next.time) - toChartSeconds(record.time)) >= 1;
      });
      const latestTime = Math.max(...nextRecords.map((record) => toChartSeconds(record.time)));
      const windowStart = latestTime - REALTIME_WINDOW_SECONDS;
      return deduped
        .filter((record) => toChartSeconds(record.time) >= windowStart)
        .slice(-REALTIME_RECORD_LIMIT);
    });
  }, [active, isRealtime, node, uuid]);

  useEffect(() => {
    setRealtimeRecords([]);
  }, [hours, uuid]);

  useEffect(() => {
    setHiddenTasks((prev) => {
      const validTaskIds = new Set(tasks.map((task) => task.id));
      const next = new Set([...prev].filter((taskId) => validTaskIds.has(taskId)));
      return next.size === prev.size ? prev : next;
    });
  }, [tasks]);
  const realtimeWindowEnd = useMemo(() => {
    if (!isRealtime) return Date.now() / 1000;
    const times = [...(data?.records ?? []), ...realtimeRecords]
      .map((record) => toChartSeconds(record.time))
      .filter((time) => time > 0);
    return times.length ? Math.max(...times) : Date.now() / 1000;
  }, [data?.records, isRealtime, realtimeRecords]);

  // 只依赖 data:切换削峰等开关时不重跑解析/排序。
  const sortedRecords = useMemo(
    () =>
      [...(data?.records ?? []), ...(isRealtime ? realtimeRecords : [])]
        .map((record) => ({
          record,
          time: toChartSeconds(record.time),
        }))
        .filter(({ time }) => time > 0)
        .filter(({ time }) => !isRealtime || time >= realtimeWindowEnd - REALTIME_WINDOW_SECONDS)
        .sort((left, right) => left.time - right.time),
    [data, isRealtime, realtimeRecords, realtimeWindowEnd],
  );

  const requestedXRange = null;
  const coverageMeta = useMemo(() => {
    if (!data) return null;
    const taskIntervals = tasks
      .map((task) => task.interval)
      .filter((value) => Number.isFinite(value) && value > 0);
    return {
      rangeStartMs: data.rangeStartMs,
      rangeEndMs: data.rangeEndMs,
      intervalSeconds:
        data.intervalSeconds ??
        (taskIntervals.length > 0 ? Math.min(...taskIntervals) : undefined),
    };
  }, [data, tasks]);
  const coverageLabel = useMemo(() => {
    const first = sortedRecords[0]?.time;
    const last = sortedRecords[sortedRecords.length - 1]?.time;
    if (first == null || last == null) return null;
    return historyCoverageLabel(coverageMeta, first, last);
  }, [coverageMeta, sortedRecords]);

  const taskStats = useMemo(() => {
    const grouped = new Map<number, PingRecord[]>();
    // 复用已按时间升序的 sortedRecords,分组后桶内天然有序,免去逐桶重排序和重复 Date.parse。
    for (const { record } of sortedRecords) {
      const bucket = grouped.get(record.task_id);
      if (bucket) bucket.push(record);
      else grouped.set(record.task_id, [record]);
    }

    const serverStats = new Map(
      pingStats
        .filter((stat) => !stat.client || stat.client === uuid)
        .map((stat) => [stat.taskId, stat] as const),
    );

    return tasks.map((task, index) => {
      const records = grouped.get(task.id) ?? [];
      const server = isRealtime ? undefined : serverStats.get(task.id);
      // server stats 命中时跳过本地全量统计(排序/分位数不便宜)。
      const fallback = server ? null : summarizePingRecords(records);
      const latest = server ? server.latest : fallback?.latest ?? null;
      const avg = server ? server.avg : fallback?.avg ?? null;
      const min = server ? server.min : fallback?.min ?? null;
      const max = server ? server.max : fallback?.max ?? null;
      const p50 = server ? server.p50 : fallback?.p50 ?? null;
      const p99 = server ? server.p99 : fallback?.p99 ?? null;
      const fallbackVolatility =
        p50 != null && p99 != null
          ? Math.max(0, p99 - p50) / Math.min(50, Math.max(10, p50))
          : null;
      const volatility =
        server && Number.isFinite(server.p99P50Ratio)
          ? server.p99P50Ratio
          : fallbackVolatility;
      const total = server?.total ?? fallback?.total ?? 0;
      const lost = server
        ? Math.max(0, server.total - server.valid)
        : fallback?.lost ?? 0;
      const loss = server?.loss ?? (total > 0 ? fallback?.loss ?? 0 : task.loss);
      return {
        ...task,
        latest,
        avg,
        min,
        max,
        p50,
        p99,
        volatility,
        total,
        lost,
        loss,
        color: taskColors.get(task.id) ?? colorForSeries(index, tasks.length),
      };
    });
  }, [isRealtime, pingStats, sortedRecords, taskColors, tasks, uuid]);

  const toggleTask = (taskId: number) => {
    setHiddenTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleAll = () => {
    setHiddenTasks((prev) => (prev.size === 0 ? new Set(tasks.map((task) => task.id)) : new Set()));
  };

  if (isLoading) {
    return <InstanceChartLoading title="Ping 图表" />;
  }

  if (isError && !sortedRecords.length) {
    return (
      <InstancePanel title="Ping 图表">
        <div className="instance-empty">
          <span>延迟历史加载失败</span>
          <button
            type="button"
            className="instance-toggle-button"
            onClick={() => void refetchRecords()}
            disabled={isFetching}
            aria-busy={isFetching}
          >
            {isFetching ? "重试中" : "重试"}
          </button>
        </div>
      </InstancePanel>
    );
  }

  if (!sortedRecords.length) {
    return (
      <InstancePanel title="Ping 图表">
        <div className="instance-empty">暂无延迟记录</div>
      </InstancePanel>
    );
  }

  return (
    <InstancePanel title="Ping 图表" description={coverageLabel ?? undefined}>
      <div className="instance-ping-toolbar">
        <SwitchToggle
          label="削峰平滑"
          active={cutPeak}
          onToggle={() => setCutPeak((value) => !value)}
          title="对延迟尖峰值做轻度平滑，仅影响延迟图线显示"
        />
        <SwitchToggle
          label="断点连线"
          active={connectNulls}
          onToggle={() => setConnectNulls((value) => !value)}
          title="关闭：如实显示中断/丢包断点；开启：跨过所有空缺连成完整曲线（更好看，但看不出掉线）。注：偶尔漏一两次采样的小空缺始终自动桥接，不受此开关影响。"
        />
        <button type="button" className="instance-toggle-button" onClick={toggleAll}>
          {hiddenTasks.size === 0 ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
          {hiddenTasks.size === 0 ? "隐藏全部" : "显示全部"}
        </button>
      </div>

      <div className="instance-ping-tasks">
        {taskStats.map((task) => {
          const visible = !hiddenTasks.has(task.id);
          return (
            <button
              key={task.id}
              type="button"
              className="instance-ping-task"
              data-visible={visible ? "true" : "false"}
              aria-pressed={visible}
              onClick={() => toggleTask(task.id)}
              style={{ borderColor: visible ? task.color : "var(--border-subtle)" }}
              title={[
                taskLabels.get(task.id) ?? `任务 #${task.id}`,
                `当前 ${task.latest != null ? `${task.latest.toFixed(1)} ms` : "—"} | 均值 ${task.avg != null ? `${task.avg.toFixed(1)} ms` : "—"} | 丢包 ${task.loss.toFixed(1)}%`,
                `p99 ${task.p99 != null ? `${task.p99.toFixed(0)} ms` : "—"} | 抖动 ${task.volatility != null ? task.volatility.toFixed(2) : "—"}`,
                `min ${task.min != null ? `${task.min.toFixed(0)} ms` : "—"} | max ${task.max != null ? `${task.max.toFixed(0)} ms` : "—"} | 样本 ${task.total ?? 0} | 间隔 ${task.interval}s`,
              ].join("\n")}
            >
              <span className="instance-ping-task-dot" style={{ background: task.color }} aria-hidden />
              <span className="instance-ping-task-name">{taskLabels.get(task.id) ?? `任务 #${task.id}`}</span>
              <span
                className="instance-ping-task-primary"
                style={{
                  color:
                    task.latest != null
                      ? latencyHeatColor(task.latest)
                      : "var(--text-tertiary)",
                }}
              >
                {task.latest != null ? `${task.latest.toFixed(1)} ms` : "—"}
              </span>
              <span
                className="instance-ping-task-loss"
                style={{ color: lossHeatColor(task.loss) }}
              >
                {task.loss.toFixed(1)}%
              </span>
            </button>
          );
        })}
      </div>

      <div className="instance-ping-figures">
        <PingMetricFigure
          uuid={uuid}
          hours={hours}
          metric="latency"
          title="延迟"
          sortedRecords={sortedRecords}
          tasks={tasks}
          taskLabels={taskLabels}
          taskColors={taskColors}
          taskKeySet={taskKeySet}
          taskKeys={taskKeys}
          taskIndexById={taskIndexById}
          visibleTasks={visibleTasks}
          hiddenTasks={hiddenTasks}
          data={data}
          requestedXRange={requestedXRange}
          connectNulls={connectNulls}
          cutPeak={cutPeak}
        />
        <PingMetricFigure
          uuid={uuid}
          hours={hours}
          metric="loss"
          title="丢包"
          sortedRecords={sortedRecords}
          tasks={tasks}
          taskLabels={taskLabels}
          taskColors={taskColors}
          taskKeySet={taskKeySet}
          taskKeys={taskKeys}
          taskIndexById={taskIndexById}
          visibleTasks={visibleTasks}
          hiddenTasks={hiddenTasks}
          data={data}
          requestedXRange={requestedXRange}
          connectNulls={connectNulls}
          cutPeak={cutPeak}
        />
      </div>
    </InstancePanel>
  );
}
