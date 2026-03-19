import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const proxyTarget =
    (env.VITE_MCP_PROXY_TARGET || env.VITE_ARCGIS_MCP_PROXY_TARGET || "http://127.0.0.1:8808").replace(/\/+$/, "");

  const proxyOptions = {
    target: proxyTarget,
    changeOrigin: true,
  };

  return {
    plugins: [react()],
    server: {
      proxy: {
        /**
         * Universal MCP relay: /dev-mcp-relay/http(s)/host:port[/path]
         *
         * The agent rewrites any absolute MCP URL into this path format so
         * the Vite dev server proxies it server-side — no CORS restrictions.
         * Uses http-proxy's `router` option for dynamic per-request targeting.
         *
         * Example:  http://0.0.0.0:8000  →  /dev-mcp-relay/http/0.0.0.0:8000/
         *           https://mcphost.io/v1 →  /dev-mcp-relay/https/mcphost.io/v1
         */
        "/dev-mcp-relay": {
          target: "http://127.0.0.1", // placeholder, always overridden by router
          changeOrigin: true,
          router(req: any): string {
            // Parse scheme and host from the URL after the /dev-mcp-relay prefix
            const after = (req.url as string)
              .replace(/^\/dev-mcp-relay/, "")
              .replace(/\?.*$/, "");
            const m = after.match(/^\/(https?)\/([^/?#]+)/);
            if (!m) return proxyTarget;
            return `${m[1]}://${m[2]}`;
          },
          rewrite(path: string): string {
            // /dev-mcp-relay/http/0.0.0.0:8000       → /
            // /dev-mcp-relay/http/0.0.0.0:8000/mcp   → /mcp
            const stripped = path.replace(/^\/dev-mcp-relay\/https?\/[^/?#]+/, "");
            return stripped.startsWith("/") ? stripped : `/${stripped}`;
          },
        },
        // Relative proxy path – enter /api/mcp in the config dialog for local dev
        "/api/mcp": {
          ...proxyOptions,
          rewrite: (path: string) => path.replace(/^\/api\/mcp/, ""),
        },
        // Backward compat
        "/api/arcgis-mcp": {
          ...proxyOptions,
          rewrite: (path: string) => path.replace(/^\/api\/arcgis-mcp/, ""),
        },
      },
    },
    build: {
      target: "esnext",
    },
  };
});
