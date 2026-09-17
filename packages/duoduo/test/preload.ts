// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import { rmSync } from "node:fs"

// Shared per-run data root: XDG dirs for the whole test process live here.
const dir = path.join(os.tmpdir(), "duoduo-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })

// Why is there NO `afterAll` teardown here?
//
// `bun run test` uses `bun test --isolate`, which re-evaluates this preload
// for EVERY test file in a fresh global environment — and preload-level
// afterAll hooks wrap every file. An `rm -rf dir` in afterAll therefore ran
// between every pair of test files. On Windows that rm routinely hit EBUSY
// (handles leaked by watchers/SQLite/PTYs), stretched past bun's 30s hook
// timeout, and kept running WHILE the next file was already executing —
// deleting directories the next file had just re-created. Symptoms:
//   - mid-file ENOENT writing Global.Path.config|.data/.gitignore
//     (tool/registry, server/routes/permission, server/routes/pty)
//   - first-test-of-file stalls of 75-110s → 30s timeouts
//     (server/routes/config|mcp|provider|experimental)
//   - "(fail) (unnamed) ... beforeEach/afterEach hook timed out"
//
// Cleanup now runs exactly once, when the test PROCESS actually exits. Under
// --isolate every file has its own `process` object, so at most the file that
// is current at exit fires (the rest are no-ops on an already-removed dir).
let dbModule: { Database: { close(): void } } | undefined

process.on("exit", () => {
  // Close the database BEFORE removing the dir: on Windows the SQLite handles
  // otherwise keep files locked until GC finalizers run.
  try {
    dbModule?.Database.close()
  } catch {}
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {}
})

// Sweep stale data roots from crashed runs (their pid is no longer alive).
// Best-effort: a swept dir can never break the current run. PID reuse by an
// unrelated live process simply keeps that dir until a later run.
try {
  for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true })) {
    const match = /^duoduo-test-data-(\d+)$/.exec(entry.name)
    if (!match || !entry.isDirectory()) continue
    const pid = Number(match[1])
    if (pid === process.pid) continue
    let alive = true
    try {
      process.kill(pid, 0)
    } catch (error) {
      // ESRCH = no such process (stale, safe to remove); EPERM = alive but
      // owned by someone else — treat as alive.
      alive = (error as NodeJS.ErrnoException)?.code === "EPERM"
    }
    if (alive) continue
    await fs
      .rm(path.join(os.tmpdir(), entry.name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      .catch(() => {})
  }
} catch {}

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["DUODUO_MODELS_PATH"] = path.join(import.meta.dir, "tool", "fixtures", "models-api.json")

// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["DUODUO_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["DUODUO_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir
process.env["DUODUO_DISABLE_DEFAULT_PLUGINS"] = "true"

// NOTE: no cache-version file is pre-written here. src/global/index.ts owns the
// cache version: on first evaluation it clears the cache once and writes the
// current CACHE_VERSION itself; subsequent files then match and skip clearing.
// (Previously a stale hardcoded version was written per file, which forced a
// full cache wipe before EVERY test file.)

// Clear provider and server auth env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["LLM_GATEWAY_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]
delete process.env["DUODUO_SERVER_PASSWORD"]
delete process.env["DUODUO_SERVER_USERNAME"]

// Use in-memory sqlite
process.env["DUODUO_DB"] = ":memory:"

// Now safe to import from src/
const { Log } = await import("../src/util")
const { initProjectors } = await import("../src/server/projectors")
// Captured for the exit handler above (dynamic import keeps env-var ordering:
// static ESM imports would hoist above the env setup).
const { Database } = await import("../src/storage")
dbModule = { Database }

void Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})

initProjectors()

// ─── Global teardown: release the ManagedRuntime ─────────────────────────────
//
// Without this, `bun test` hangs after the last test passes: the module-level
// ManagedRuntime (src/effect/app-runtime.ts) is never disposed, and services
// built inside it (EffectFlock retry timers, FileWatcher, Bus heartbeats, …)
// keep real event-loop handles alive. The process then never exits — which is
// exactly the SIGKILL the CI unit-test job died from.
//
// AppRuntime.dispose() closes the runtime scope, releasing those handles.
// `ensureRuntimeHealth()` recreates the runtime on next use, so non-isolate
// multi-file runs keep working. Raced against a timeout because a hung
// disposer must never block bun's afterAll window.
import { afterAll } from "bun:test"
const { AppRuntime } = await import("../src/effect/app-runtime")

afterAll(async () => {
  await Promise.race([
    AppRuntime.dispose().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
})

