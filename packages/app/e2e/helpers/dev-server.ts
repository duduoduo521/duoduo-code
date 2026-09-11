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
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startMockLLM, type MockLLMServer } from "../mock-llm/server"
import { startIsolatedBackend, encodeProjectPath, type IsolatedBackend } from "./backend"

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
}

// Parse --port argument
const portArg = process.argv.findIndex((a) => a === "--port")
const vitePort = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3000

async function main() {
  // 1. Start mock LLM
  const mock = await startMockLLM(0)
  console.log(`[e2e:dev-server] mock-llm at ${mock.url}`)

  // 2. Start isolated backend
  const backend = await startIsolatedBackend({ mockLlmUrl: mock.url })
  console.log(`[e2e:dev-server] backend at ${backend.url}`)

  // 3. Write runtime info
  const info: RuntimeInfo = {
    mockLlmUrl: mock.url,
    backendUrl: backend.url,
    backendPort: backend.port,
    projectDir: backend.projectDir,
    projectPathEncoded: encodeProjectPath(backend.projectDir),
  }
  mkdirSync(dirname(RUNTIME_INFO_PATH), { recursive: true })
  writeFileSync(RUNTIME_INFO_PATH, JSON.stringify(info, null, 2))
  console.log(`[e2e:dev-server] runtime info written to ${RUNTIME_INFO_PATH}`)

  // 4. Start Vite dev server with backend port injected
  const vite = spawn("bun", ["run", "dev", "--", "--host", "0.0.0.0", "--port", String(vitePort)], {
    cwd: APP_PKG,
    env: {
      ...process.env,
      VITE_DUODUO_SERVER_HOST: "127.0.0.1",
      VITE_DUODUO_SERVER_PORT: String(backend.port),
    },
    stdio: "inherit",
  })

  // Cleanup on exit
  const cleanup = async () => {
    try { vite.kill("SIGTERM") } catch {}
    try { await backend.stop() } catch {}
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
