#!/usr/bin/env bun
/**
 * E2E dev server wrapper script.
 *
 * This script is used as the Playwright webServer command. It:
 *   1. Starts the mock LLM server
 *   2. Starts the isolated backend
 *   3. Writes runtime info to .runtime-info.json
 *   4. Starts the Vite dev server with the backend port injected
 *
 * Usage: bun run e2e/helpers/dev-server.ts [--port PORT]
 *
 * When the parent process (Playwright) kills this script,
 * the backend and mock LLM are cleaned up.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startMockLLM, type MockLLMServer } from "../mock-llm/server"
import { startIsolatedBackend, createIsolatedXdgDirs, encodeProjectPath, type IsolatedBackend, type IsolatedXdgDirs } from "./backend"
import { startSmartLayerSidecar, isSmartLayerAvailable, type SmartLayerSidecar } from "./smart-layer"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../../../..")
const APP_PKG = resolve(REPO_ROOT, "packages/app")
const RUNTIME_INFO_PATH = resolve(__dirname, ".runtime-info.json")

export interface RuntimeInfo {
  mockLlmUrl: string
  backendUrl: string
  backendPort: number
  projectDir: string
  projectPathEncoded: string
  /** URL of the Rust smart-layer sidecar, or null when it was not started. */
  smartLayerUrl: string | null
  /** Whether the sidecar is running (gates sidecar-backed specs). */
  smartLayerAvailable: boolean
  /** 智械 gear packs dir exposed to the backend as DUODUO_GEARS_DIR. */
  gearsDir: string
}

// Parse --port argument
const portArg = process.argv.findIndex((a) => a === "--port")
const vitePort = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3000

async function main() {
  // 1. Start mock LLM
  const mock = await startMockLLM(0)
  console.log(`[e2e:dev-server] mock-llm at ${mock.url}`)

  // 智械 gear packs dir: specs install gear packs (incl. MCP servers) here.
  // Created BEFORE the sidecar so both processes get DUODUO_GEARS_DIR.
  const gearsDir = join(tmpdir(), `duoduo-e2e-gears-${process.pid}`)
  mkdirSync(gearsDir, { recursive: true })

  // 2. Start the Rust smart-layer sidecar (when built) with XDG dirs shared
  //    with the backend, so both agree on the per-project data dir.
  //    A sidecar that fails to START must not take the whole harness down —
  //    degrade to sidecar-less mode so unaffected specs still run and
  //    sidecar-backed specs skip (never fake-red).
  let sidecar: SmartLayerSidecar | null = null
  let sharedXdg: IsolatedXdgDirs | undefined
  if (isSmartLayerAvailable()) {
    sharedXdg = createIsolatedXdgDirs()
    try {
      sidecar = await startSmartLayerSidecar({
        xdgEnv: sharedXdg.env,
        logDir: join(sharedXdg.root, "logs"),
        gearsDir,
      })
      console.log(`[e2e:dev-server] smart-layer sidecar at ${sidecar.url}`)
    } catch (err) {
      console.error(
        `[e2e:dev-server] smart-layer sidecar failed to start (${String(err)}) — ` +
          `continuing WITHOUT it; sidecar-backed specs will skip`,
      )
      sidecar = null
    }
  } else {
    console.log(
      `[e2e:dev-server] duo-smart-layer binary not found — sidecar-backed tests will skip. ` +
        `Build with \`cargo build -p duo-smart-layer\`.`,
    )
  }

  // 3. Start isolated backend (wired to the sidecar when present)
  const backend = await startIsolatedBackend({
    mockLlmUrl: mock.url,
    smartLayerUrl: sidecar?.url,
    xdg: sharedXdg,
    gearsDir,
  })
  console.log(`[e2e:dev-server] backend at ${backend.url} (gears: ${gearsDir})`)

  // 4. Write runtime info
  const info: RuntimeInfo = {
    mockLlmUrl: mock.url,
    backendUrl: backend.url,
    backendPort: backend.port,
    projectDir: backend.projectDir,
    projectPathEncoded: encodeProjectPath(backend.projectDir),
    smartLayerUrl: sidecar?.url ?? null,
    smartLayerAvailable: sidecar !== null,
    gearsDir,
  }
  mkdirSync(dirname(RUNTIME_INFO_PATH), { recursive: true })
  writeFileSync(RUNTIME_INFO_PATH, JSON.stringify(info, null, 2))
  console.log(`[e2e:dev-server] runtime info written to ${RUNTIME_INFO_PATH}`)

  // 5. Start Vite dev server with the backend/sidecar ports injected
  const vite = spawn("bun", ["run", "dev", "--", "--host", "0.0.0.0", "--port", String(vitePort)], {
    cwd: APP_PKG,
    env: {
      ...process.env,
      VITE_DUODUO_SERVER_HOST: "127.0.0.1",
      VITE_DUODUO_SERVER_PORT: String(backend.port),
      // vite.config.ts 的 /gears /agent 等代理路由读的是这个变量。
      // 有侧车时代理打到侧车（/agent /gears 由 Rust 承载）；
      // 无侧车时退回旧行为（打到 TS 后端，相关用例自行 skip）。
      DUO_SMART_LAYER_PORT: String(sidecar?.port ?? backend.port),
    },
    stdio: "inherit",
  })

  // Cleanup on exit
  const cleanup = async () => {
    try { vite.kill("SIGTERM") } catch {}
    try { await backend.stop() } catch {}
    try { await sidecar?.stop() } catch {}
    try { await mock.stop() } catch {}
  }

  process.on("SIGTERM", async () => {
    await cleanup()
    process.exit(0)
  })
  process.on("SIGINT", async () => {
    await cleanup()
    process.exit(0)
  })

  vite.on("exit", (code) => {
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    cleanup()
    process.exit(code ?? 0)
  })
}

main().catch((err) => {
  console.error("[e2e:dev-server] fatal:", err)
  process.exit(1)
})
