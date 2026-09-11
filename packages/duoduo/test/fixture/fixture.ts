import { $ } from "bun"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Context } from "effect"
import type * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { Config } from "../../src/config"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import type * as Project from "../../src/project/project"
import { ProjectTable } from "../../src/project/project.sql"
import { Database } from "../../src/storage"
import { TestLLMServer } from "../lib/llm-server"
import { APP_CONFIG_SCHEMA } from "../../src/config/domains"

// Strip null bytes from paths (defensive fix for CI environment issues)
function sanitizePath(p: string): string {
  return p.replace(/\0/g, "")
}

function exists(dir: string) {
  return fs
    .stat(dir)
    .then(() => true)
    .catch(() => false)
}

function clean(dir: string) {
  return fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}

async function stop(dir: string) {
  if (!(await exists(dir))) return
  await $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow()
}

type TmpDirOptions<T> = {
  git?: boolean
  config?: Partial<Config.Info>
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
}
export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const dirpath = sanitizePath(path.join(os.tmpdir(), "duoduo-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })
  if (options?.git) {
    await $`git init`.cwd(dirpath).quiet()
    await $`git config core.fsmonitor false`.cwd(dirpath).quiet()
    await $`git config commit.gpgsign false`.cwd(dirpath).quiet()
    await $`git config user.email "test@duoduo.test"`.cwd(dirpath).quiet()
    await $`git config user.name "Test"`.cwd(dirpath).quiet()
    await $`git commit --allow-empty -m "root commit ${dirpath}"`.cwd(dirpath).quiet()
  }
  if (options?.config) {
    await Bun.write(
      path.join(dirpath, "duoduo-ai.json"),
      JSON.stringify({
        $schema: APP_CONFIG_SCHEMA,
        ...options.config,
      }),
    )
  }
  const realpath = sanitizePath(await fs.realpath(dirpath))
  const extra = await options?.init?.(realpath)
  const result = {
    [Symbol.asyncDispose]: async () => {
      try {
        await options?.dispose?.(realpath)
      } finally {
        if (options?.git) await stop(realpath).catch(() => undefined)
        await clean(realpath).catch(() => undefined)
      }
    },
    path: realpath,
    extra: extra as T,
  }
  return result
}

/** Effectful scoped tmpdir. Cleaned up when the scope closes. Make sure these stay in sync */
export function tmpdirScoped(options?: { git?: boolean; config?: Partial<Config.Info> }) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dirpath = sanitizePath(path.join(os.tmpdir(), "duoduo-test-" + Math.random().toString(36).slice(2)))
    yield* Effect.promise(() => fs.mkdir(dirpath, { recursive: true }))
    const dir = sanitizePath(yield* Effect.promise(() => fs.realpath(dirpath)))

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (options?.git) await stop(dir).catch(() => undefined)
        await clean(dir).catch(() => undefined)
      }),
    )

    const git = (...args: string[]) =>
      spawner.spawn(ChildProcess.make("git", args, { cwd: dir })).pipe(Effect.flatMap((handle) => handle.exitCode))

    if (options?.git) {
      yield* git("init")
      yield* git("config", "core.fsmonitor", "false")
      yield* git("config", "commit.gpgsign", "false")
      yield* git("config", "user.email", "test@duoduo.test")
      yield* git("config", "user.name", "Test")
      yield* git("commit", "--allow-empty", "-m", "root commit")
    }

    if (options?.config) {
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(dir, "duoduo-ai.json"),
          JSON.stringify({ $schema: APP_CONFIG_SCHEMA, ...options.config }),
        ),
      )
    }

    return dir
  })
}

export const provideInstance =
  (directory: string, project?: Project.Info, worktree?: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.contextWith((services: Context.Context<R>) =>
      Effect.promise<A>(async () =>
        Instance.provide({
          directory,
          project,
          worktree,
          fn: () => {
            // When tests bypass project discovery by supplying a precomputed
            // project Info, we still need a row in ProjectTable so foreign-key
            // dependent operations (Session, Share, Message, Part) can succeed.
            if (project) {
              try {
                Database.use((db) =>
                  db
                    .insert(ProjectTable)
                    .values({
                      id: project.id,
                      worktree: project.worktree,
                      vcs: project.vcs,
                      sandboxes: project.sandboxes ?? [],
                      time_created: project.time?.created ?? Date.now(),
                      time_updated: project.time?.updated ?? Date.now(),
                    })
                    .onConflictDoNothing()
                    .run(),
                )
              } catch {
                // best-effort — fixture insertion races are acceptable
              }
            }
            return Effect.runPromiseWith(services)(self.pipe(Effect.provideService(InstanceRef, Instance.current)))
          },
        }),
      ),
    )

/** Build a lightweight Project.Info for a freshly git-initialized tmpdir.
 *  Avoids spawning additional git processes (discoverProject) since
 *  we already know the repo layout from the tmpdir setup. */
export function testProjectInfo(directory: string, isGit: boolean): { project: Project.Info; worktree: string } {
  if (isGit) {
    return {
      project: {
        id: ProjectID.global,
        worktree: directory,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
      worktree: directory,
    }
  }
  return {
    project: {
      id: ProjectID.global,
      worktree: "/",
      vcs: undefined,
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    },
    worktree: "/",
  }
}

export function provideTmpdirInstance<A, E, R>(
  self: (path: string) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: Partial<Config.Info> },
): Effect.Effect<A, E, R> {
  // When no config is provided, supply a default test provider so the instance can resolve models
  const config = options?.config ?? defaultTestConfig("http://127.0.0.1:0/v1")
  const isGit = !!options?.git
  return Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ ...options, config })
    let provided = false

    const { project, worktree } = testProjectInfo(dir, isGit)

    yield* Effect.addFinalizer(() =>
      provided
        ? Effect.promise(() =>
            Instance.provide({
              directory: dir,
              fn: () => Instance.dispose(),
            }),
          ).pipe(Effect.ignore)
        : Effect.void,
    )

    provided = true
    return yield* self(dir).pipe(provideInstance(dir, project, worktree))
  }) as Effect.Effect<A, E, R>
}

const defaultTestConfig = (url: string): Partial<Config.Info> => ({
  enabled_providers: ["test"],
  provider: {
    test: {
      name: "Test",
      npm: "@ai-sdk/openai-compatible",
      api: url,
      options: {
        apiKey: "test-key",
        baseURL: url,
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
})

export function provideTmpdirServer<A, E, R>(
  self: (input: { dir: string; llm: TestLLMServer["Service"] }) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: (url: string) => Partial<Config.Info> },
): Effect.Effect<
  A,
  E | PlatformError.PlatformError,
  R | TestLLMServer | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const config = options?.config?.(llm.url) ?? defaultTestConfig(llm.url)
    return yield* provideTmpdirInstance((dir) => self({ dir, llm }), {
      git: options?.git,
      config,
    })
  })
}
