import { useEffect, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { CONFIG_QUERY_KEY } from "@/hooks/usePublicConfig";
import { exchangeTurnstileVerification, getConfig } from "@/services/api";
import {
  TURNSTILE_INVALID_EVENT,
  clearTurnstileToken,
  hasStoredTurnstileVerified,
  loadTurnstileScript,
  setTurnstileToken,
} from "@/utils/turnstile";

interface TurnstileGateInfo {
  enabled: boolean;
  siteKey: string;
  verified: boolean;
}

const GATE_DISABLED: TurnstileGateInfo = { enabled: false, siteKey: "", verified: false };

function isTurnstileEnabled(value: unknown) {
  return value === true || value === "true";
}

function mapConfigToGate(config: Record<string, unknown>): TurnstileGateInfo {
  return {
    enabled: isTurnstileEnabled(config.turnstile_enabled),
    siteKey: String(config.turnstile_site_key || ""),
    verified: config.verified === true,
  };
}

export interface TurnstileGateState {
  blocked: boolean;
  failed: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  retry: () => void;
}

// 全局 Turnstile 开启且本地没有有效凭证时拦住数据请求，
// 渲染验证码组件，通过后换取加密的 turnstile_verified 再放行。
export function useTurnstileGate(): TurnstileGateState {
  // 与 usePublicConfig 共用同一份 /api/config 缓存，只读取不重复请求
  const { data } = useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: () => getConfig(),
    select: mapConfigToGate,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: false,
  });
  const [passed, setPassed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const gate = data ?? GATE_DISABLED;
  const blocked =
    !passed &&
    gate.enabled &&
    gate.siteKey.length > 0 &&
    !gate.verified &&
    !hasStoredTurnstileVerified();

  useEffect(() => {
    const onInvalid = () => {
      // 凭证被后端拒绝（403）后重新出验证码
      setPassed(false);
      setAttempt((value) => value + 1);
    };
    window.addEventListener(TURNSTILE_INVALID_EVENT, onInvalid);
    return () => window.removeEventListener(TURNSTILE_INVALID_EVENT, onInvalid);
  }, []);

  useEffect(() => {
    if (!blocked) return undefined;
    setFailed(false);
    let cancelled = false;
    let widgetId: string | null = null;
    const container = containerRef.current;

    loadTurnstileScript()
      .then(() => {
        if (cancelled) return;
        if (!container || !window.turnstile) {
          setFailed(true);
          return;
        }
        widgetId = window.turnstile.render(container, {
          sitekey: gate.siteKey,
          callback: (token: string) => {
            setTurnstileToken(token);
            exchangeTurnstileVerification()
              .then((verified) => {
                if (cancelled) return;
                if (verified) setPassed(true);
                else setFailed(true);
              })
              .catch(() => {
                if (!cancelled) setFailed(true);
              });
          },
          errorCallback: () => {
            if (!cancelled) setFailed(true);
          },
          expiredCallback: () => {
            clearTurnstileToken();
            if (!cancelled) {
              setPassed(false);
              setFailed(true);
            }
          },
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      try {
        if (widgetId != null) window.turnstile?.remove(widgetId);
      } catch {
        // Ignore stale widget ids.
      }
      if (container) container.innerHTML = "";
    };
  }, [blocked, gate.siteKey, attempt]);

  const retry = () => setAttempt((value) => value + 1);

  return { blocked, failed, containerRef, retry };
}

export function TurnstileGatePanel({ gate }: { gate: TurnstileGateState }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-5 text-center">
      <div className="space-y-2">
        <div className="text-[15px] font-semibold text-[var(--text-primary)]">
          安全验证
        </div>
        <p className="max-w-[32rem] text-[13px] text-[var(--text-secondary)]">
          {gate.failed
            ? "人机验证未完成，请点击下方按钮重试。"
            : "请先完成人机验证以查看节点数据。"}
        </p>
      </div>
      <div
        ref={gate.containerRef}
        className="flex min-h-[65px] items-center justify-center"
      />
      {gate.failed && (
        <button
          type="button"
          onClick={gate.retry}
          className="control-button px-4 py-2 text-[13px] font-medium"
        >
          重试验证
        </button>
      )}
    </div>
  );
}
