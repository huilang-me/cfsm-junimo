export const TURNSTILE_TOKEN_KEY = "turnstile_token";
export const TURNSTILE_VERIFIED_KEY = "turnstile_verified";
// 403 清掉本地 Turnstile 缓存后广播该事件，让验证门重新出现
export const TURNSTILE_INVALID_EVENT = "cfsm-turnstile-invalid";

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

interface TurnstileRenderOptions {
  sitekey: string;
  callback?: (token: string) => void;
  errorCallback?: (error?: unknown) => void;
  expiredCallback?: () => void;
  [key: string]: unknown;
}

interface TurnstileGlobal {
  render: (container: HTMLElement | string, options: TurnstileRenderOptions) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId?: string | HTMLElement) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
  }
}

function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getTurnstileToken() {
  return readStorage(TURNSTILE_TOKEN_KEY) || "";
}

export function setTurnstileToken(token: string) {
  if (!token) return;
  try {
    localStorage.setItem(TURNSTILE_TOKEN_KEY, token);
  } catch {
    // Storage unavailable (private mode etc.), verification just won't persist.
  }
}

export function clearTurnstileToken() {
  try {
    localStorage.removeItem(TURNSTILE_TOKEN_KEY);
  } catch {
    // Ignore.
  }
}

export function hasStoredTurnstileVerified() {
  return Boolean(readStorage(TURNSTILE_VERIFIED_KEY));
}

// 与原版前端 http.js 行为一致：保存加密的 verified 串并丢弃一次性 token
export function storeTurnstileVerified(encrypted: string) {
  try {
    localStorage.setItem(TURNSTILE_VERIFIED_KEY, encrypted);
    localStorage.removeItem(TURNSTILE_TOKEN_KEY);
  } catch {
    // Ignore.
  }
}

export function clearTurnstileVerified() {
  try {
    localStorage.removeItem(TURNSTILE_VERIFIED_KEY);
  } catch {
    // Ignore.
  }
}

let turnstileScriptPromise: Promise<void> | null = null;

export function loadTurnstileScript() {
  if (typeof window === "undefined") return Promise.reject(new Error("No window"));
  if (window.turnstile) return Promise.resolve();

  turnstileScriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      turnstileScriptPromise = null;
      reject(new Error("Failed to load Turnstile script"));
    };
    document.head.appendChild(script);
  });

  return turnstileScriptPromise;
}
