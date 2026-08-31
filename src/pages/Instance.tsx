import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import "uplot/dist/uPlot.min.css";
import { InstanceDetails } from "@/components/instance/InstanceDetails";
import { PingChart } from "@/components/instance/PingChart";
import { LoadChart } from "@/components/instance/LoadChart";
import { Spinner } from "@/components/ui/Spinner";
import { buildLoadTimeRangeOptions } from "@/components/instance/chartShared";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { useNodeMeta, useNodeStoreStatus } from "@/hooks/useNode";
import { useInstanceHistory } from "@/hooks/useRecords";
import { useThemeSettings } from "@/hooks/useThemeSettings";

type TimeRangeOption = ReturnType<typeof buildLoadTimeRangeOptions>[number];

function RangeSelector({
  ranges,
  value,
  onChange,
}: {
  ranges: TimeRangeOption[];
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="instance-range-selector is-scrollable">
      {ranges.map((range) => (
        <button
          key={range.value}
          type="button"
          data-active={value === range.value ? "true" : "false"}
          aria-pressed={value === range.value}
          onClick={() => onChange(range.value)}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}

export function Instance() {
  const { uuid } = useParams<{ uuid: string }>();
  const { data: config } = usePublicConfig();
  const themeSettings = useThemeSettings();
  const meta = useNodeMeta(uuid ?? "", "node");
  const storeStatus = useNodeStoreStatus(Boolean(uuid), "node", uuid ?? "");
  const [loadHours, setLoadHours] = useState(0);
  const chartControlsRef = useRef<HTMLDivElement | null>(null);
  const historyHours = loadHours === 0 ? 0.167 : loadHours;
  const historyQuery = useInstanceHistory(uuid ?? "", historyHours, Boolean(uuid && meta));

  const metricRetentionHours =
    config?.metric_retention_days && config.metric_retention_days > 0
      ? config.metric_retention_days * 24
      : null;

  const loadRanges = useMemo(
    () => buildLoadTimeRangeOptions(metricRetentionHours ?? config?.record_preserve_time),
    [config?.record_preserve_time, metricRetentionHours],
  );
  const showPingChart = themeSettings.isReady && themeSettings.showPingChart;
  const loadHistoryQuery = useMemo(
    () => ({
      data: historyQuery.data?.load,
      isError: historyQuery.isError,
      isFetching: historyQuery.isFetching,
      isLoading: historyQuery.isLoading,
      refetch: () => {
        void historyQuery.refetch();
      },
    }),
    [historyQuery],
  );
  const pingHistoryQuery = useMemo(
    () => ({
      data: historyQuery.data?.ping,
      isError: historyQuery.isError,
      isFetching: historyQuery.isFetching,
      isLoading: historyQuery.isLoading,
      refetch: () => {
        void historyQuery.refetch();
      },
    }),
    [historyQuery],
  );

  const alignCharts = useCallback(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = chartControlsRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (rect.top >= 0 && rect.top < window.innerHeight) return;
      element.scrollIntoView({ behavior: "auto", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!loadRanges.some((range) => range.value === loadHours)) {
      setLoadHours(loadRanges[0]?.value ?? 0);
    }
  }, [loadHours, loadRanges]);

  if (!uuid) return null;

  if (!meta) {
    const message = storeStatus.hydrated
      ? "找不到这个实例，它可能已被删除或链接无效。"
      : storeStatus.nodeInfoError
        ? "节点列表加载失败，系统正在自动重试。"
        : null;
    return (
      <div className="flex flex-col gap-5 py-2">
        <Link to="/" className="instance-page-back">
          <ChevronLeft size={14} />
          返回
        </Link>
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
          {message ? (
            <>
              <div className="text-[15px] font-semibold text-[var(--text-primary)]">
                {storeStatus.hydrated ? "实例不存在" : "暂时无法加载实例"}
              </div>
              <p className="text-[13px] text-[var(--text-secondary)]">{message}</p>
            </>
          ) : (
            <Spinner size={24} label="正在加载实例" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-2">
      <Link
        to="/"
        className="instance-page-back"
      >
        <ChevronLeft size={14} />
        返回
      </Link>
      <InstanceDetails uuid={uuid} onNodeReady={alignCharts} />
      <div ref={chartControlsRef} className="instance-chart-controls">
        <RangeSelector
          ranges={loadRanges}
          value={loadHours}
          onChange={(value) => startTransition(() => setLoadHours(value))}
        />
      </div>
      <div className="instance-chart-stage">
        <LoadChart uuid={uuid} hours={loadHours} historyQuery={loadHistoryQuery} />
        {showPingChart ? (
          <PingChart uuid={uuid} hours={loadHours} historyQuery={pingHistoryQuery} />
        ) : null}
      </div>
    </div>
  );
}
