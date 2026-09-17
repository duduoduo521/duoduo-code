/**
 * Helpers for spinning up an isolated backend instance for e2e tests.
 *
 * The user's running backend on :4096 is not used. Instead, we start
 * a per-worker isolated `duoduo serve` subprocess pointing at:
 *   - DUODUO_TEST_HOME      → a fresh tmp home directory
 *   - DUODUO_CONFIG_DIR     → a fresh tmp config directory pre-populated
 *                              with a mock-OpenAI-compatible provider
 *   - DUODUO_DEV            → 1 (uses the `duoduocode-dev` data dir)
 *   - DUODUO_DISABLE_PROJECT_CONFIG → 1 (no .duoduo discovery)
 *
 * No production code is modified. Teardown removes all tmp dirs.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../../../..")
const DUODUO_PKG = resolve(REPO_ROOT, "packages/duoduo")

export interface IsolatedBackend {
  port: number
  url: string
  homeDir: string
  configDir: string
  projectDir: string
  stop: () => Promise<void>
}

export interface BackendOptions {
  /** Port for the duoduo backend (defaults to picking a free port). */
  backendPort?: number
  /** URL of an already-started mock LLM server (e.g. http://127.0.0.1:4097). */
  mockLlmUrl: string
  /** Default model id to write into config (e.g. "mock/success-text-short"). */
  defaultModel?: string
  /** Directory into which test project files will be seeded. */
  projectName?: string
  /**
   * URL of a running duo-smart-layer sidecar. When set, the backend gets
   * DUO_SMART_LAYER_URL so prompt/run-loop flows delegate to the Rust side.
   */
  smartLayerUrl?: string
  /**
   * Pre-created XDG dirs to reuse (shared with a sidecar started by the
   * caller). When omitted, fresh isolated XDG dirs are created internally.
   */
  xdg?: { root: string; env: Record<string, string> }
}

export interface IsolatedXdgDirs {
  root: string
  env: Record<string, string>
}

/**
 * Create an isolated set of XDG base dirs. Callers that run a duo-smart-layer
 * sidecar alongside the backend should create these ONCE and pass them to
 * both `startSmartLayerSidecar({ xdgEnv })` and
 * `startIsolatedBackend({ xdg })` so both processes share the data dir.
 */
export function createIsolatedXdgDirs(): IsolatedXdgDirs {
  const root = mkdtempSync(join(tmpdir(), "duoduo-e2e-xdg-"))
  const config = join(root, "config")
  const data = join(root, "data")
  const cache = join(root, "cache")
  const state = join(root, "state")
  for (const d of [config, data, cache, state]) mkdirSync(d, { recursive: true })
  return {
    root,
    env: {
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: state,
    },
  }
}

function buildMockProviderConfig(mockLlmUrl: string, defaultModel: string) {
  // The custom provider will use `@ai-sdk/openai-compatible` (default for
  // unknown providers) and hit `<mockLlmUrl>/v1/chat/completions/<modelId>`.
  // Each model id corresponds to a fixture file in `e2e/mock-llm/fixtures/`.
  const fixtures = [
    "success-text-short",
    "success-text-multi-chunk",
    "success-text-markdown",
    "success-tool-read",
    "success-tool-edit",
    "success-tool-malformed-args",
    "error-401-html-gateway",
    "error-503-empty-body",
    "error-status-only-number",
    "error-429-rate-limit",
    "error-context-overflow",
    "truncated-mid-text",
    "truncated-finish-length",
    "slow-streaming",
    "streaming-long",
  ]
  const models: Record<string, unknown> = {}
  for (const id of fixtures) {
    models[id] = {
      id,
      name: id,
      attachment: false,
      tool_call: true,
      cost: { input: 0, output: 0 },
      limit: { context: 32000, output: 4096 },
      modalities: { input: ["text"], output: ["text"] },
    }
  }
  return {
    $schema: "https://www.dd322.cn/code/config.json",
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        api: `${mockLlmUrl}/v1`,
        options: {
          baseURL: `${mockLlmUrl}/v1`,
          apiKey: "mock-key-not-used",
          timeout: 30000,
        },
        models,
      },
    },
    enabled_providers: ["mock"],
    model: `mock/${defaultModel}`,
    small_model: `mock/${defaultModel}`,
    autoupdate: false,
  }
}

function pickFreePort(): number {
  // 4096 is the default reserved by docs; pick well above it.
  // 4196..4795 keeps us out of common dev ports.
  return 4196 + Math.floor(Math.random() * 600)
}

async function waitForReady(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown = null
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/doc`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return
      lastErr = new Error(`status ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`backend at ${url} not ready after ${timeoutMs}ms: ${String(lastErr)}`)
}

export async function startIsolatedBackend(opts: BackendOptions): Promise<IsolatedBackend> {
  const homeDir = mkdtempSync(join(tmpdir(), "duoduo-e2e-home-"))
  const configDir = mkdtempSync(join(tmpdir(), "duoduo-e2e-cfg-"))
  // Reuse caller-provided XDG dirs when shared with a sidecar; else create fresh.
  const sharedXdg = opts.xdg ?? null
  const xdgRoot = sharedXdg?.root ?? createIsolatedXdgDirs().root
  const xdgConfigHome = sharedXdg?.env.XDG_CONFIG_HOME ?? join(xdgRoot, "config")
  const xdgDataHome = sharedXdg?.env.XDG_DATA_HOME ?? join(xdgRoot, "data")
  const xdgCacheHome = sharedXdg?.env.XDG_CACHE_HOME ?? join(xdgRoot, "cache")
  const xdgStateHome = sharedXdg?.env.XDG_STATE_HOME ?? join(xdgRoot, "state")
  if (!sharedXdg) {
    for (const d of [xdgConfigHome, xdgDataHome, xdgCacheHome, xdgStateHome]) mkdirSync(d, { recursive: true })
  }
  const projectRoot = mkdtempSync(join(tmpdir(), "duoduo-e2e-proj-"))
  const projectDir = opts.projectName ? join(projectRoot, opts.projectName) : projectRoot
  if (projectDir !== projectRoot) mkdirSync(projectDir, { recursive: true })

  // Pre-create the duoduocode-dev global config dir and seed config.json.
  // Global.Path.config is computed once at module-load using XDG_CONFIG_HOME,
  // so we must set XDG_CONFIG_HOME (not just DUODUO_CONFIG_DIR) for full isolation.
  const globalConfigSubdir = join(xdgConfigHome, "duoduocode-dev")
  mkdirSync(globalConfigSubdir, { recursive: true })

  // Seed the project with a minimal git-like marker so the worktree
  // detector treats it as a project root.
  writeFileSync(join(projectDir, "README.md"), "# E2E Test Project\n")
  // .git ensures Worktree.find() recognizes it; a dummy file is enough.
  mkdirSync(join(projectDir, ".git"), { recursive: true })
  writeFileSync(join(projectDir, ".git", "HEAD"), "ref: refs/heads/main\n")
  writeFileSync(join(projectDir, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n")
  mkdirSync(join(projectDir, ".git", "objects"), { recursive: true })
  mkdirSync(join(projectDir, ".git", "refs", "heads"), { recursive: true })

  const defaultModel = opts.defaultModel ?? "success-text-short"
  const config = buildMockProviderConfig(opts.mockLlmUrl, defaultModel)
  // Write into both the global XDG config (primary) and the explicit
  // DUODUO_CONFIG_DIR (defensive, in case path resolution changes).
  writeFileSync(join(globalConfigSubdir, "config.json"), JSON.stringify(config, null, 2))
  writeFileSync(join(configDir, "duoduo.json"), JSON.stringify(config, null, 2))

  const port = opts.backendPort ?? pickFreePort()

  const child: ChildProcess = spawn(
    "bun",
    ["run", "--conditions=browser", "./src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: DUODUO_PKG,
      env: {
        ...process.env,
        DUODUO_TEST_HOME: homeDir,
        DUODUO_CONFIG_DIR: configDir,
        DUODUO_DEV: "1",
        DUODUO_DISABLE_PROJECT_CONFIG: "1",
        DUODUO_FIXED_DIRECTORY: projectDir,
        // XDG paths must be set so Global.Path.* resolves to our isolated dirs.
        XDG_CONFIG_HOME: xdgConfigHome,
        XDG_DATA_HOME: xdgDataHome,
        XDG_CACHE_HOME: xdgCacheHome,
        XDG_STATE_HOME: xdgStateHome,
        HOME: homeDir,
        // Force backend to skip auth.
        DUODUO_SERVER_PASSWORD: "",
        // Wire the backend to a running Rust smart-layer sidecar (if any).
        // Per packages/duoduo/src/smart-layer/index.ts the env var wins over
        // the well-known URL file, and setting it at process start avoids the
        // startup race where clients are created before the sidecar is ready.
        ...(opts.smartLayerUrl ? { DUO_SMART_LAYER_URL: opts.smartLayerUrl } : {}),
        // Prevent telemetry / network calls.
        DUODUO_DISABLE_AUTOUPDATE: "1",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  // Pipe child output for debugging.
  child.stdout?.on("data", (d) => process.stderr.write(`[backend:${port}] ${d}`))
  child.stderr?.on("data", (d) => process.stderr.write(`[backend:${port}] ${d}`))

  let exited = false
  child.on("exit", (code, signal) => {
    exited = true
    if (code !== 0 && code !== null) {
      process.stderr.write(`[backend:${port}] exited code=${code} signal=${signal}\n`)
    }
  })

  const url = `http://127.0.0.1:${port}`

  const stop = async () => {
    if (!exited && child.pid) {
      try {
        child.kill("SIGTERM")
        await new Promise<void>((resolve) => {
          if (exited) return resolve()
          const t = setTimeout(() => {
            try {
              child.kill("SIGKILL")
            } catch {
              // ignore
            }
            resolve()
          }, 3_000)
          child.once("exit", () => {
            clearTimeout(t)
            resolve()
          })
        })
      } catch {
        // ignore
      }
    }
    // Shared XDG dirs are owned by the caller (sidecar/dev-server) — only
    // clean up dirs we created ourselves.
    for (const dir of [homeDir, configDir, ...(sharedXdg ? [] : [xdgRoot]), projectRoot]) {
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }

  try {
    await waitForReady(url)
  } catch (err) {
    await stop()
    throw err
  }

  return { port, url, homeDir, configDir, projectDir, stop }
}

/**
 * Encode a directory path into the URL-safe base64 form used by the
 * IDE's project routes (e.g. `/L3RtcC90ZXN0LXByb2plY3Q/session`).
 */
export function encodeProjectPath(dir: string): string {
  // The frontend uses standard base64 url-safe encoding without padding.
  return Buffer.from(dir, "utf8").toString("base64url")
}
