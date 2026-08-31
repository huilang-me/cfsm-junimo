import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import tailwindcss from "@tailwindcss/vite";

function stripQuotes(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function escapeHtmlAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function devApiBasePlugin(apiBase: string): PluginOption {
  if (!apiBase) return null;
  return {
    name: "cfsm-dev-api-base",
    apply: "serve",
    transformIndexHtml(html) {
      const meta = `<meta name="apiBase" content="${escapeHtmlAttr(apiBase)}">`;
      if (/<meta\b(?=[^>]*\bname=["']apiBase["'])[^>]*>/i.test(html)) {
        return html.replace(
          /<meta\b(?=[^>]*\bname=["']apiBase["'])[^>]*>/i,
          meta,
        );
      }
      return html.replace(/(<head[^>]*>)/i, `$1\n    ${meta}`);
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const devApiBase =
    command === "serve" ? stripQuotes(env.API_BASE || env.VITE_API_BASE || "") : "";

  return {
    plugins: [react(), basicSsl(), tailwindcss(), devApiBasePlugin(devApiBase)],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    build: {
      // 与 CSS 实际基线对齐:全站大量 color-mix()/oklch(需 Chrome 111 / Safari 16.2+),
      // JS 没必要为更老的引擎转译。
      target: ["es2022", "chrome111", "safari16.2", "firefox113"],
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replace(/\\/g, "/");
            if (!normalized.includes("/node_modules/")) return;

            if (
              /\/node_modules\/(?:react|react-dom|react-router|react-router-dom)\//.test(
                normalized,
              )
            ) {
              return "react";
            }
            if (normalized.includes("/node_modules/@tanstack/react-query/")) {
              return "query";
            }
            if (/\/node_modules\/(?:uplot|uplot-react)\//.test(normalized)) {
              return "charts";
            }
            if (normalized.includes("/node_modules/zod/")) {
              return "validation";
            }
          },
        },
      },
    },
  };
});
