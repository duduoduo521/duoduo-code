import { defineConfig } from "vite"
import appPlugin from "@duoduo-ai/app/vite"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const host = process.env.TAURI_DEV_HOST

// Resolve the ACTUAL duo-smart-layer port at request time. The sidecar boots
// on a RANDOM port (Tauri learns it from the sidecar's stdout / a $TMPDIR port
// file), so the static `DUO_SMART_LAYER_PORT` env is almost always unset when
// Vite starts. A hard-coded fallback (53267) is a dead port and makes relative
// fetches — the `sl.api==null` fallback path — hang the marketplace on its
// skeleton forever. Instead we resolve the live port from the port file the
// sidecar writes to $TMPDIR on every startup (`duoduo-smart-layer-port-*.txt`).
// NOTE: on macOS `std::env::temp_dir()` is `$TMPDIR` (e.g. /var/folders/.../T/),
// NOT `/tmp`, so we read `$TMPDIR`, not a hard-coded `/tmp`.
function smartLayerTarget(): string {
  const fallback = `http://127.0.0.1:${process.env.DUO_SMART_LAYER_PORT ?? "53267"}`
  try {
    const tmp = process.env.TMPDIR ?? process.env.TMP ?? "/tmp"
    const files = readdirSync(tmp).filter(
      (f) => f.startsWith("duoduo-smart-layer-port-") && f.endsWith(".txt"),
    )
    if (files.length > 0) {
      // Newest file wins (stale files from crashed runs are ignored).
      files.sort(
        (a, b) =>
          statSync(path.join(tmp, b)).mtimeMs - statSync(path.join(tmp, a)).mtimeMs,
      )
      const port = readFileSync(path.join(tmp, files[0]), "utf8").trim()
      if (/^\d+$/.test(port)) return `http://127.0.0.1:${port}`
    }
  } catch {
    // ignore — fall through to the env/default below
  }
  return fallback
}

// Per-request dynamic target so the proxy always points at the live sidecar
// port even though it's only known after Vite has already started.
const backendProxy = {
  target: smartLayerTarget(),
  router: () => smartLayerTarget(),
  changeOrigin: true,
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [appPlugin],
  publicDir: "../app/public",
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // Vite 8: esbuild replaced by Oxc (transforms) + Rolldown (bundler)
  // keepNames is now set via rolldownOptions
  build: {
    rolldownOptions: {
      output: {
        keepNames: false,
        manualChunks(id) {
          if (id.includes("/node_modules/shiki/")) return "vendor-shiki"
          if (id.includes("/node_modules/@codemirror/") || id.includes("/node_modules/codemirror/")) {
            if (id.includes("/node_modules/@codemirror/lang-")) return "vendor-codemirror-lang"
            return "vendor-codemirror"
          }
          if (id.includes("/node_modules/effect/") || id.includes("/node_modules/@effect/")) return "vendor-effect"
          if (id.includes("/node_modules/solid-js/")) return "vendor-solid"
        },
      },
    },
  },
  // 4. pre-bundle heavy dependencies to speed up first page load
  optimizeDeps: {
    include: [
      "shiki",
      "marked",
      "marked-shiki",
      "katex",
      "marked-katex-extension",
      "diff",
      "luxon",
      "fuzzysort",
      "remeda",
      "zod",
      "effect",
      "solid-js",
      "@tanstack/solid-query",
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/search",
      "@codemirror/autocomplete",
      "virtua",
    ],
  },
  // build: {
  // sourcemap: true,
  // },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      "/gears": { ...backendProxy },
      "/agent": { ...backendProxy },
      "/session": { ...backendProxy },
      "/v1": { ...backendProxy },
      "/context": { ...backendProxy },
      "/hooks": { ...backendProxy },
      "/mcp": { ...backendProxy },
      "/health": { ...backendProxy },
    },
  },
})
