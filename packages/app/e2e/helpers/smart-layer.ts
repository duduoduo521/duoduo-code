/**
 * Helper for starting an isolated duo-smart-layer (Rust) sidecar for e2e tests.
 *
 * The sidecar binary is discovered from (in order):
 *   1. `DUODUO_E2E_SMART_LAYER_BIN` env override (explicit path)
 *   2. `<repo>/target/debug/duo-smart-layer(.exe)`
 *   3. `<repo>/target/release/duo-smart-layer(.exe)`
 *
 * Build it with: `cargo build -p duo-smart-layer`
 * (CI's e2e workflow does this automatically.)
 *
 * The sidecar shares the caller-provided XDG dirs with the TS backend so both
 * processes agree on the per-project data dir (duoduo.db, auth.json, ...).
 * When the binary is absent the harness starts without the sidecar and
 * affected specs skip themselves (never fake-red).
 *
 * No production code is modified. Teardown kills the process.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../../../..")

export interface SmartLayerSidecar {
  port: number
  url: string
  stop: () => Promise<void>
}

/** Locate the duo-smart-layer binary, or return null when not built. */
export function findSmartLayerBinary(): string | null {
  const override = process.env.DUODUO_E2E_SMART_LAYER_BIN
  if (override) return existsSync(override) ? override : null
  const exe = process.platform === "win32" ? "duo-smart-layer.exe" : "duo-smart-layer"
  for (const profile of ["debug", "release"]) {
    const p = join(REPO_ROOT, "target", profile, exe)
    if (existsSync(p)) return p
  }
  return null
}

/** True when a sidecar binary is available and sidecar-backed tests can run. */
export function isSmartLayerAvailable(): boolean {
  return findSmartLayerBinary() !== null
}

function pickPort(): number {
  // Keep clear of the backend range (4196..4795) and common dev ports.
  return 4806 + Math.floor(Math.random() * 200)
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown = null
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return
      lastErr = new Error(`status ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`smart-layer at ${url} not ready after ${timeoutMs}ms: ${String(lastErr)}`)
}

export interface SidecarOptions {
  /**
   * Shared XDG env (XDG_CONFIG_HOME / XDG_DATA_HOME / ...) — must be the same
   * object passed to the TS backend so both processes resolve the same
   * per-project data dir.
   */
  xdgEnv?: Record<string, string>
  /** Log dir override (DUODUO_LOG_DIR). Also enables sidecar file logging. */
  logDir?: string
  /** Fixed port (defaults to a random free port). */
  port?: number
}

export async function startSmartLayerSidecar(opts: SidecarOptions = {}): Promise<SmartLayerSidecar> {
  const bin = findSmartLayerBinary()
  if (!bin) {
    throw new Error("duo-smart-layer binary not found — build it with `cargo build -p duo-smart-layer`")
  }

  const port = opts.port ?? pickPort()
  const child: ChildProcess = spawn(bin, [], {
    env: {
      ...process.env,
      DUO_SMART_LAYER_PORT: String(port),
      DUODUO_DEV: "1",
      ...(opts.logDir ? { DUODUO_LOG_DIR: opts.logDir } : {}),
      ...(opts.xdgEnv ?? {}),
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  // Pipe child output for debugging; the ready marker ("DUO_SMART_LAYER_READY|port=N")
  // is informational here since we poll /health directly.
  child.stdout?.on("data", (d) => process.stderr.write(`[smart-layer:${port}] ${d}`))
  child.stderr?.on("data", (d) => process.stderr.write(`[smart-layer:${port}] ${d}`))

  let exited = false
  child.on("exit", (code, signal) => {
    exited = true
    if (code !== 0 && code !== null) {
      process.stderr.write(`[smart-layer:${port}] exited code=${code} signal=${signal}\n`)
    }
  })

  const stop = async () => {
    if (!exited && child.pid) {
      try {
        child.kill("SIGTERM")
        await new Promise<void>((resolveStop) => {
          if (exited) return resolveStop()
          const t = setTimeout(() => {
            try {
              child.kill("SIGKILL")
            } catch {
              // ignore
            }
            resolveStop()
          }, 3_000)
          child.once("exit", () => {
            clearTimeout(t)
            resolveStop()
          })
        })
      } catch {
        // ignore
      }
    }
  }

  const url = `http://127.0.0.1:${port}`
  try {
    await waitForHealth(url)
  } catch (err) {
    await stop()
    throw err
  }

  return { port, url, stop }
}
