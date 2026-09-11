/**
 * Shared Test Runtime
 *
 * Long-term solution for fast, reliable unit tests.
 *
 * Key design:
 * - AppRuntime singleton with shared memoMap → layers built once, reused across all tests
 * - Test-safe effect execution with InstanceRef provided
 * - Proper cleanup (env vars, instance disposal)
 * - Explicit git/no-git tmpdir (avoid unnecessary git init cost)
 */
import { afterEach, beforeEach } from "bun:test"
import { APP_CONFIG_SCHEMA } from "../../src/config/domains"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, ManagedRuntime, Layer } from "effect"
import { AppLayer, AppRuntime } from "../../src/effect/app-runtime"
import { InstanceRef } from "../../src/effect/instance-ref"
import { WorkspaceRef } from "../../src/effect/instance-ref"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import type { Config } from "../../src/config"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"

// ---------------------------------------------------------------------------
// 1. Shared AppRuntime (singleton, memoMap cache)
// ---------------------------------------------------------------------------
// AppRuntime already exists as a singleton in app-runtime.ts with a shared
// memoMap.  We just expose a convenience wrapper so tests don't need to
// know which runtime to use — they always go through AppRuntime.

export { AppRuntime }

// ---------------------------------------------------------------------------
// 2. Instance-provided Effect runner (avoids createPlugTask overhead)
// ---------------------------------------------------------------------------
// Instead of calling Instance.provide() (which does project discovery,
// git probes, DB upsert), provideInstanceContext directly provides
// InstanceRef + WorkspaceRef into the AppRuntime's shared layer graph.

export function provideInstanceContext(context: {
  directory: string
  worktree: string
}): <A, E>(effect: Effect.Effect<A, E>) => Promise<A> {
  const ctx = {
    directory: context.directory,
    worktree: context.worktree,
    project: {
      id: ProjectID.global,
      worktree: context.worktree,
      vcs: context.directory === context.worktree ? undefined : "git",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    },
  }
  return <A, E>(effect: Effect.Effect<A, E>) =>
    AppRuntime.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx as any)))
}

// ---------------------------------------------------------------------------
// 3. Lightweight test directory (no git init by default)
// ---------------------------------------------------------------------------
// tmpdir() with git: true does `git init`, `git config` (5 cmds), `git commit`.
// That's ~300-500ms per test.  Many tests don't need git at all.
// This variant does a plain mkdtemp — zero overhead.

export interface TestDirOptions {
  git?: boolean
  config?: Partial<Config.Info>
}

function sanitizePath(p: string) {
  return p.replace(/\0/g, "")
}

export async function createTestDir(options?: TestDirOptions): Promise<{
  path: string
  worktree: string
  dispose: () => Promise<void>
}> {
  const dirpath = sanitizePath(path.join(os.tmpdir(), "duoduo-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })

  const dir = sanitizePath(await fs.realpath(dirpath))

  if (options?.git) {
    // Lazy import bun to avoid top-level side effects
    const { $ } = await import("bun")
    await $`git init`.cwd(dir).quiet()
    await $`git config core.fsmonitor false`.cwd(dir).quiet()
    await $`git config commit.gpgsign false`.cwd(dir).quiet()
    await $`git config user.email "test@duoduo.test"`.cwd(dir).quiet()
    await $`git config user.name "Test"`.cwd(dir).quiet()
    await $`git commit --allow-empty -m "root commit"`.cwd(dir).quiet()
  }

  if (options?.config) {
    await fs.writeFile(
      path.join(dir, "duoduo-ai.json"),
      JSON.stringify({
        $schema: APP_CONFIG_SCHEMA,
        ...options.config,
      }),
    )
  }

  const worktree = options?.git ? dir : dir

  return {
    path: dir,
    worktree,
    dispose: async () => {
      if (options?.git) {
        const { $ } = await import("bun")
        await $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow()
      }
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
    },
  }
}

// ---------------------------------------------------------------------------
// 4. Environment variable guard
// ---------------------------------------------------------------------------
// Many tests mutate process.env.  If an assertion fails before the restore
// line, the leaked env var pollutes subsequent tests.
//
// Usage:
//   test("something", () => {
//     using _env = withEnv({ MY_KEY: "value" })
//     // ... assertions ...
//   })  // env restored on scope exit, even if assertions fail

export function withEnv(vars: Record<string, string | undefined>): Disposable {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  return {
    [Symbol.dispose]: () => {
      for (const [key, oldValue] of saved) {
        if (oldValue === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = oldValue
        }
      }
    },
  }
}

// Or the async version for async tests:
export function withEnvAsync(vars: Record<string, string | undefined>): AsyncDisposable {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  return {
    [Symbol.asyncDispose]: async () => {
      for (const [key, oldValue] of saved) {
        if (oldValue === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = oldValue
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 5. Standard test lifecycle hooks
// ---------------------------------------------------------------------------
// Call this in describe blocks to ensure proper cleanup between tests.
//
// Usage:
//   describe("my tests", () => {
//     setupTestLifecycle()
//     test("...", ...)
//   })

/** Default test config that provides a minimal provider for model resolution */
export const defaultTestConfig: Partial<Config.Info> = {
  enabled_providers: ["test"],
  provider: {
    test: {
      name: "Test",
      npm: "@ai-sdk/openai-compatible",
      api: "http://127.0.0.1:0/v1",
      options: {
        apiKey: "test-key",
        baseURL: "http://127.0.0.1:0/v1",
      },
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          release_date: "2025-01-01",
          attachment: true,
          reasoning: false,
          temperature: true,
          tool_call: true,
          limit: { context: 200_000, output: 32_000 },
        },
      },
    },
  },
}

/**
 * Add this afterEach hook in describe blocks that use Instance.provide.
 * It disposes all cached instances to prevent state leakage between tests,
 * matching the established pattern in 16 other test files.
 */
export function setupTestLifecycle() {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => {})
  })
}

/**
 * Combined helper: creates a temp dir and runs an effect with InstanceRef
 * provided through the shared AppRuntime.  No Instance.provide() overhead.
 */
export async function withTestDir<A>(
  fn: (ctx: { dir: string; run: <A>(effect: Effect.Effect<A>) => Promise<A> }) => Promise<A>,
  options?: { git?: boolean },
): Promise<A> {
  const td = await createTestDir(options)
  try {
    const run = provideInstanceContext({ directory: td.path, worktree: td.worktree })
    return await fn({ dir: td.path, run })
  } finally {
    await td.dispose()
  }
}
