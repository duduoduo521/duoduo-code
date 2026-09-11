import { defineConfig } from "vite"
import desktopPlugin from "./vite"

// Dev-only: forward backend API calls to the Rust smart-layer. The server
// reports its port via `DUO_SMART_LAYER_READY|port=<p>` on stdout. Launch it
// with a fixed `DUO_SMART_LAYER_PORT` (e.g. 8787) so this proxy stays stable
// across restarts. Falls back to the port observed during this session.
const backendTarget = `http://127.0.0.1:${process.env.DUO_SMART_LAYER_PORT ?? "53267"}`

export default defineConfig({
  plugins: [desktopPlugin] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
    proxy: {
      // During `bun run dev` the frontend runs on :3000 but the Rust API runs
      // on a separate port. Without this proxy, requests like /gears/market hit
      // Vite and return index.html ("Unexpected token '<'"). Proxy them through.
      "/gears": { target: backendTarget, changeOrigin: true },
      "/agent": { target: backendTarget, changeOrigin: true },
      "/session": { target: backendTarget, changeOrigin: true },
      "/v1": { target: backendTarget, changeOrigin: true },
      "/context": { target: backendTarget, changeOrigin: true },
      "/hooks": { target: backendTarget, changeOrigin: true },
      "/mcp": { target: backendTarget, changeOrigin: true },
      "/health": { target: backendTarget, changeOrigin: true },
    },
  },
  build: {
    target: "esnext",
    // sourcemap: true,
  },
  optimizeDeps: {
    include: ["@codemirror/state", "@codemirror/view", "@codemirror/search", "@codemirror/autocomplete"],
  },
})
