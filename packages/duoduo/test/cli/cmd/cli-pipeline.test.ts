import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

/**
 * h) CLI pipeline integration (process-level, spawns the real CLI):
 *
 *   1. `run --format json` — stdout must be a CLEAN NDJSON pipe: every line
 *      parses as JSON and carries the `type` discriminator (P2-15: stderr is
 *      message-only and never merges into the pipe).
 *   2. `acp` — when the ACP client hangs up (stdin EOF) the process must exit
 *      deterministically (bounded graceful teardown), never linger as an
 *      orphan.
 */

const SSE_BODY = [
  'data: {"id":"m1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"hello from mock"},"finish_reason":null}]}',
  "",
  'data: {"id":"m1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  "",
].join("\n")

// Prompts containing this marker make the mock LLM reject the request with a
// 401 (non-retryable auth error) so the run loop fails fast.
const FAIL_MARKER = "fail please"

// The two `run --format json` tests delegate the prompt to the Rust run loop
// inside the duo-smart-layer sidecar; without the debug binary (the plain CI
// unit job never builds Rust) the CLI cannot complete a delegated run. Gated,
// not deleted — same convention as test/session/prompt.test.ts (runRunLoop):
// Rust has no equivalent NDJSON pipe coverage, so these run wherever the
// sidecar exists (local dev) and are skipped in the plain unit suite.
const sidecarBin = join(
  join(import.meta.dir, "../../../.."),
  "..",
  "target",
  "debug",
  process.platform === "win32" ? "duo-smart-layer.exe" : "duo-smart-layer",
)
const hasSidecar = existsSync(sidecarBin)

let server: ReturnType<typeof Bun.serve>
let llmUrl: string
let homeDir: string
let configDir: string
let cacheDir: string
let dataDir: string
let stateDir: string
let sidecar: ReturnType<typeof Bun.spawn> | null = null
let smartLayerUrl: string | null = null

function cliEnv(): Record<string, string> {
  return {
    ...process.env,
    DUODUO_TEST_HOME: homeDir,
    HOME: homeDir,
    DUODUO_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_STATE_HOME: stateDir,
    // `run` delegates the prompt to the Rust run loop — the sidecar must be
    // reachable for the delegation to succeed (harness mirrors the e2e one).
    ...(smartLayerUrl ? { DUO_SMART_LAYER_URL: smartLayerUrl } : {}),
    DUODUO_SERVER_PASSWORD: "",
    DUODUO_DISABLE_AUTOUPDATE: "1",
    NO_COLOR: "1",
  } as Record<string, string>
}

beforeAll(async () => {
  // Minimal OpenAI-compatible mock: one content chunk, finish stop, [DONE].
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      console.log(`[mock] ${req.method} ${url.pathname}${url.search}`)
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [] })
      }
      if (url.pathname.endsWith("/chat/completions")) {
        // The failing-LLM test variant: a 401 auth error is non-retryable, so
        // the run loop fails fast and the terminal error must still surface
        // through the pipe (see the `fail please` test below).
        const body = await req.text()
        if (body.includes(FAIL_MARKER)) {
          return Response.json({ error: { message: "mock auth failure", type: "invalid_request_error" } }, { status: 401 })
        }
        return new Response(SSE_BODY, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  llmUrl = `http://localhost:${server.port}`

  homeDir = mkdtempSync(join(tmpdir(), "duoduo-cli-json-"))
  configDir = join(homeDir, "config")
  dataDir = join(homeDir, "data")
  cacheDir = join(homeDir, "cache")
  stateDir = join(homeDir, "state")
  for (const d of [configDir, dataDir, cacheDir, stateDir]) mkdirSync(d, { recursive: true })

  // Point the CLI at the mock provider. Global.Path.config resolves to
  // $XDG_CONFIG_HOME/duoduocode-dev — write BOTH that (primary) and the
  // explicit DUODUO_CONFIG_DIR (defensive, mirrors the e2e harness).
  const globalConfigSubdir = join(configDir, "duoduocode-dev")
  mkdirSync(globalConfigSubdir, { recursive: true })
  const configJson = JSON.stringify({
      $schema: "https://www.dd322.cn/code/config.json",
      provider: {
        mock: {
          npm: "@ai-sdk/openai-compatible",
          name: "Mock",
          api: `${llmUrl}/v1`,
          options: { baseURL: `${llmUrl}/v1`, apiKey: "mock-key", timeout: 30000 },
          models: {
            test: {
              id: "test",
              name: "test",
              attachment: false,
              tool_call: true,
              cost: { input: 0, output: 0 },
              limit: { context: 32000, output: 4096 },
              modalities: { input: ["text"], output: ["text"] },
            },
          },
        },
      },
      enabled_providers: ["mock"],
      model: "mock/test",
      small_model: "mock/test",
      autoupdate: false,
    })
  writeFileSync(join(globalConfigSubdir, "config.json"), configJson)
  writeFileSync(join(configDir, "duoduo.json"), configJson)

  // Start the Rust sidecar (same XDG dirs, so it reads the same config) —
  // `run` delegates the prompt to the run loop inside this process.
  if (!hasSidecar) {
    console.warn(`[cli-pipeline] sidecar binary not found at ${sidecarBin} — run tests will be skipped`)
  } else {
    sidecar = Bun.spawn([sidecarBin], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configDir,
        XDG_DATA_HOME: dataDir,
        XDG_CACHE_HOME: cacheDir,
        XDG_STATE_HOME: stateDir,
        HOME: homeDir,
        DUODUO_LOG_DIR: join(homeDir, "sidecar-logs"),
        // The run use-case exercises the prompt pipe, not the knowledge
        // graph — indexing the repo would slow every round by minutes.
        DUODUO_KG_ENABLED: "false",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    // Drain stderr so the sidecar never blocks on a full pipe.
    ;(async () => {
      const r = sidecar!.stderr.getReader()
      while (true) {
        const { done } = await r.read()
        if (done) break
      }
    })().catch(() => {})
    // Discover the port from the ready marker, then wait for /health.
    const port = await Promise.race([
      (async () => {
        const t = new TextDecoder()
        const r = sidecar!.stdout.getReader()
        let buf = ""
        while (true) {
          const { done, value } = await r.read()
          if (done) return null
          buf += t.decode(value)
          const m = buf.match(/DUO_SMART_LAYER_READY\|port=(\d+)/)
          if (m) return Number(m[1])
        }
      })(),
      Bun.sleep(15_000).then(() => null),
    ])
    if (port) {
      smartLayerUrl = `http://127.0.0.1:${port}`
      for (let i = 0; i < 50; i++) {
        try {
          const res = await fetch(`${smartLayerUrl}/health`)
          if (res.ok) break
        } catch {}
        await Bun.sleep(200)
      }
    } else {
      console.warn("[cli-pipeline] sidecar ready marker not seen — run tests will fail")
    }
  }
})

afterAll(async () => {
  server.stop(true)
  sidecar?.kill()
  await Bun.sleep(200)
  rmSync(homeDir, { recursive: true, force: true })
})

describe("CLI pipeline (--format json / acp)", () => {
  test.skipIf(!hasSidecar)(
    "run --format json emits a clean NDJSON pipe on stdout",
    async () => {
      // Run the CLI from a scratch directory: the instance directory drives
      // project-side work (KG indexing, snapshot tracking) that would
      // otherwise target this repo and slow every runLoop round by minutes.
      const workDir = join(homeDir, "work")
      mkdirSync(workDir, { recursive: true })
      const child = Bun.spawn(
        ["bun", join(import.meta.dir, "../../..", "src/index.ts"), "run", "--format", "json", "--model", "mock/test", "say hi"],
        {
        cwd: workDir,
        env: cliEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      let stdout = ""
      let stderr = ""
      await Promise.all([
        (async () => {
          const t = new TextDecoder()
          const r = child.stdout.getReader()
          while (true) {
            const { done, value } = await r.read()
            if (done) break
            stdout += t.decode(value)
          }
        })(),
        (async () => {
          const t = new TextDecoder()
          const r = child.stderr.getReader()
          while (true) {
            const { done, value } = await r.read()
            if (done) break
            stderr += t.decode(value)
          }
        })(),
      ])
      const code = await child.exited
      if (code !== 0) {
        console.error("[diag] stderr:", stderr.slice(0, 1200))
        console.error("[diag] stdout:", stdout.slice(0, 400))
      }
      expect(code).toBe(0)

      const lines = stdout.split("\n").filter((l) => l.trim().length > 0)
      if (lines.length === 0) {
        console.error("[diag] run stdout empty; stderr:", stderr.slice(0, 800))
      }
      expect(lines.length).toBeGreaterThan(0)
      // EVERY stdout line is a valid NDJSON event with the discriminator —
      // any UI/noise line here breaks downstream `| jq` consumers.
      for (const line of lines) {
        const parsed = JSON.parse(line)
        expect(typeof parsed.type).toBe("string")
        expect(typeof parsed.timestamp).toBe("number")
        expect(typeof parsed.sessionID).toBe("string")
      }
      // The assistant answer must be part of the pipe.
      expect(stdout).toContain("hello from mock")
      // P2-15: stderr is message-only — it must not carry JSON events.
      for (const line of stderr.split("\n").filter((l) => l.trim().startsWith("{"))) {
        expect(() => JSON.parse(line)).toThrow()
      }
    },
    120_000,
  )

  test.skipIf(!hasSidecar)(
    "run --format json surfaces LLM failures as error events with exit code 1",
    async () => {
      const workDir = join(homeDir, "work-fail")
      mkdirSync(workDir, { recursive: true })
      const child = Bun.spawn(
        ["bun", join(import.meta.dir, "../../..", "src/index.ts"), "run", "--format", "json", "--model", "mock/test", FAIL_MARKER],
        {
          cwd: workDir,
          env: cliEnv(),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      let stdout = ""
      let stderr = ""
      await Promise.all([
        (async () => {
          const t = new TextDecoder()
          const r = child.stdout.getReader()
          while (true) {
            const { done, value } = await r.read()
            if (done) break
            stdout += t.decode(value)
          }
        })(),
        (async () => {
          const t = new TextDecoder()
          const r = child.stderr.getReader()
          while (true) {
            const { done, value } = await r.read()
            if (done) break
            stderr += t.decode(value)
          }
        })(),
      ])
      const code = await child.exited
      if (code !== 1) {
        console.error("[diag] fail-case code:", code)
        console.error("[diag] fail-case stderr:", stderr.slice(0, 2000))
        console.error("[diag] fail-case stdout:", stdout.slice(0, 800))
      }
      // Automation (CI/pipes) must be able to detect the failure via the exit
      // code — exit 0 on a failed run would make `run` useless for pipelines.
      expect(code).toBe(1)

      // The terminal failure must be visible in the pipe as an error event
      // (the delegated runLoop path never emits session.error — the error
      // travels on the assistant message's `error` field instead).
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0)
      const events = lines.map((l) => JSON.parse(l))
      expect(events.some((e) => e.type === "error")).toBe(true)
      for (const line of lines) {
        const parsed = JSON.parse(line)
        expect(typeof parsed.type).toBe("string")
        expect(typeof parsed.timestamp).toBe("number")
      }
      // P2-15: stderr stays message-only.
      for (const line of stderr.split("\n").filter((l) => l.trim().startsWith("{"))) {
        expect(() => JSON.parse(line)).toThrow()
      }
    },
    120_000,
  )

  test(
    "acp exits deterministically when the client hangs up (stdin EOF)",
    async () => {
      const child = Bun.spawn(["bun", "src/index.ts", "acp"], {
        cwd: import.meta.dir + "/../../..",
        env: cliEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      // Drain the pipes so the child never blocks on a full buffer.
      const drain = (stream: ReadableStream<Uint8Array>) => {
        ;(async () => {
          const r = stream.getReader()
          while (true) {
            const { done } = await r.read()
            if (done) break
          }
        })().catch(() => {})
      }
      drain(child.stdout)
      drain(child.stderr)

      // Give the bootstrap + server a moment to come up, then hang up.
      await Bun.sleep(6_000)
      child.stdin.end()

      // Deterministic exit within the teardown bound (3s) plus slack.
      const exited = await Promise.race([
        child.exited.then((code) => ({ exited: true as const, code })),
        Bun.sleep(15_000).then(() => ({ exited: false as const, code: -1 })),
      ])
      expect(exited.exited).toBe(true)
      expect(exited.code).toBe(0)
      child.kill()
    },
    60_000,
  )
})
