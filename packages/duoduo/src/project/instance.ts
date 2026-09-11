import { GlobalBus } from "@/bus/global"
import { disposeInstance } from "@/effect/instance-registry"
import { attach } from "@/effect/run-service"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { iife } from "@/util/iife"
import { withTimeout } from "@/util/timeout"
import { Log } from "@/util"
import { LocalContext } from "../util"
import * as Project from "./project"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { Layer, ManagedRuntime } from "effect"
import * as Observability from "@/effect/observability"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
  /**
   * Sandbox (road-2) task-level allowed paths. Extends the project boundary
   * with additional directories the current task may read/write — e.g.
   * "read code in project A, program in project B" or "read data in folder A,
   * program in project B". Files/bash targets inside any allowed path do NOT
   * trigger the external_directory ask gate. Undefined ⇒ legacy behaviour
   * (only `directory` + `worktree` are in-bounds). This is a logical sandbox
   * (path allow-list), not an OS-level bind-mount; OS isolation is a separate
   * later work item.
   */
  allowedPaths?: string[]
}

const context = LocalContext.create<InstanceContext>("instance")
const cache = new Map<string, Promise<InstanceContext>>()

// Independent memo map for the project mini-runtime.
// Sharing AppRuntime's memoMap across runtimes can cause
// "Service not found: @duoduo/FileSystem" when the AppRuntime
// reuses memoized layers referencing the wrong Scope.
const projectMemoMap = Layer.makeMemoMapUnsafe()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let projectRt: any
const getProjectRuntime = () =>
  (projectRt ??= ManagedRuntime.make(Layer.provideMerge(Project.defaultLayer, Observability.layer), {
    memoMap: projectMemoMap,
  }))

const project = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runPromise: <A>(fn: (svc: any) => any) => getProjectRuntime().runPromise(attach(Project.Service.use(fn))),
}

const disposal = {
  all: undefined as Promise<void> | undefined,
}

function boot(input: { directory: string; init?: () => Promise<any>; worktree?: string; project?: Project.Info }) {
  return iife(async () => {
    let ctx: InstanceContext
    if (input.project && input.worktree) {
      ctx = {
        directory: input.directory,
        worktree: input.worktree,
        project: input.project,
      }
    } else {
      // P3: Use discoverProject (git probe only, ~1-2 spawn) instead of
      // fromDirectory (git probe + DB upsert, ~5-6 spawn) to return a
      // usable InstanceContext immediately.  fromDirectory runs
      // fire-and-forget below to complete DB persistence.
      const { project: discoveredProject, sandbox } = await project.runPromise((svc) =>
        svc.discoverProject(input.directory),
      )
      ctx = {
        directory: input.directory,
        worktree: sandbox,
        project: discoveredProject,
      }

      // Reuse the discovery data so fromDirectory skips Phase 1 git probe
      // (0 redundant git spawns instead of ~3-4).
      const precomputed = {
        id: discoveredProject.id,
        worktree: discoveredProject.worktree,
        sandbox,
        vcs: discoveredProject.vcs,
      }

      // Fire-and-forget: complete full fromDirectory (DB upsert, icon
      // discovery, etc.) in the background.  On success, update the
      // cached ctx with the fully-hydrated project so subsequent requests
      // see the complete Info.
      void project
        .runPromise((svc) => svc.fromDirectory(input.directory, precomputed))
        .then(({ project: fullProject }: { project: Project.Info }) => {
          // Guard: only mutate if the cache still resolves to our ctx.
          // If Instance.reload/dispose replaced the entry, skip the update
          // to avoid mutating a stale (disposed) InstanceContext.
          const current = cache.get(input.directory)
          if (current) {
            current
              .then((c) => {
                if (c === ctx) ctx.project = fullProject
              })
              .catch(() => {})
          }
        })
        .catch((err: unknown) => {
          Log.Default.warn("fromDirectory (background) failed", { directory: input.directory, error: err })
        })
    }
    // Await init to ensure env vars and other setup are in place before
    // the caller (fn) accesses lazily-initialized services like Provider.
    // Without this, env var setup races with Provider state initialization.
    // If init fails, propagate the error: a failed bootstrap (e.g. config
    // load error) must not let the command run against a half-initialized
    // instance, which would surface as cryptic downstream failures.
    if (input.init) {
      try {
        await context.provide(ctx, () => input.init!())
      } catch (err) {
        Log.Default.error("bootstrap init failed", { directory: input.directory, error: err })
        throw err
      }
    }
    return ctx
  })
}

function track(directory: string, next: Promise<InstanceContext>) {
  const task = next.catch((error) => {
    if (cache.get(directory) === task) cache.delete(directory)
    throw error
  })
  cache.set(directory, task)
  return task
}

/**
 * Resolve an InstanceContext for the given directory.
 * Wraps the cache lookup so that rejected promises are automatically
 * evicted (the `track` helper already does this) and callers get a
 * clean retry.
 */
async function resolveInstance(
  directory: string,
  init?: () => Promise<any>,
  project?: Project.Info,
  worktree?: string,
): Promise<InstanceContext> {
  let existing = cache.get(directory)
  if (!existing) {
    Log.Default.info("creating instance", { directory })
    return track(directory, boot({ directory, init, project, worktree }))
  }
  return existing
}

const SERVICE_NOT_FOUND_RE = /Service not found/
const MAX_SERVICE_NOT_FOUND_RETRIES = 3
const RETRY_DELAY_MS = 100

export const Instance = {
  async provide<R>(input: {
    directory: string
    init?: () => Promise<any>
    fn: () => R
    project?: Project.Info
    worktree?: string
  }): Promise<R> {
    const directory = AppFileSystem.resolve(input.directory)
    for (let attempt = 0; attempt <= MAX_SERVICE_NOT_FOUND_RETRIES; attempt++) {
      try {
        const ctx = await resolveInstance(directory, input.init, input.project, input.worktree)
        return await context.provide(ctx, async () => input.fn())
      } catch (err: any) {
        // The cached instance may have been disposed between resolution and
        // execution. ScopedCache entries are invalidated on dispose, causing
        // downstream Effects to fail with "Service not found: @duoduocode/...".
        // Detect this, evict the stale cache entry, dispose all ScopedCache
        // entries for the directory, and retry with a fresh boot.
        if (SERVICE_NOT_FOUND_RE.test(err?.message ?? "") && attempt < MAX_SERVICE_NOT_FOUND_RETRIES) {
          Log.Default.info("instance context expired mid-request, re-creating", { directory, attempt })
          await disposeInstance(directory).catch(() => {})
          cache.delete(directory)
          // Brief delay to allow AppRuntime context stabilization before retry.
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)))
          continue
        }
        throw err
      }
    }
    // Unreachable, but satisfies TypeScript
    throw new Error("Max retries exceeded")
  },
  get current() {
    return context.use()
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },
  /**
   * Required for the `ctx`-less branch of `containsPath`, which reads fields off
   * this object cast as an InstanceContext. Without this getter `allowedPaths`
   * reads as `undefined` there and every approved directory keeps re-prompting.
   */
  get allowedPaths() {
    return context.use().allowedPaths
  },

  /**
   * Check if a path is within the project boundary.
   * Returns true if path is inside Instance.directory OR Instance.worktree,
   * OR any entry in Instance.allowedPaths (directories the user already approved).
   * Paths within the worktree but outside the working directory should not trigger external_directory permission.
   */
  containsPath(filepath: string, ctx?: InstanceContext) {
    const instance = ctx ?? (Instance as unknown as InstanceContext)
    if (AppFileSystem.contains(instance.directory, filepath)) return true
    // Non-git projects set worktree to "/" which would match ANY absolute path.
    // Skip worktree check in this case to preserve external_directory permissions.
    if (instance.worktree !== "/") {
      if (AppFileSystem.contains(instance.worktree, filepath)) return true
    }
    if (instance.allowedPaths?.length) {
      // Entries are stored realpath-resolved by `addAllowedPath`, while
      // `filepath` arrives as the agent wrote it. `contains` is a pure string
      // comparison, so on platforms where the temp/home dirs are symlinks
      // (macOS: /var -> /private/var) the two forms would never match and an
      // approved directory would keep re-prompting. Resolve both sides.
      const resolved = AppFileSystem.resolve(filepath)
      for (const p of instance.allowedPaths) {
        if (AppFileSystem.contains(p, resolved)) return true
      }
    }
    return false
  },

  /**
   * Record a directory the user has *already approved* via an
   * `external_directory` prompt.
   *
   * This is a cache of granted permissions, not a configuration surface: it is
   * only ever written from `Permission.reply` when the user answers "always",
   * and there is deliberately no UI or config key to pre-populate it. Users
   * cannot be expected to enumerate the directories a task will touch up front;
   * the agent discovers a boundary, asks, and the answer lands here.
   *
   * Two consumers depend on it:
   *  - `containsPath`, so an approved directory stops re-prompting;
   *  - `postRunLoop`, which ships it to Rust as `allowed_paths` so that
   *    `SecurityPolicy::check_path_access` agrees with the TS-side decision.
   *
   * `dir` is resolved to an absolute normalized path. Idempotent.
   *
   * @param ctx explicit context; required when called outside the instance ALS
   *            (e.g. from an HTTP-driven permission reply).
   */
  addAllowedPath(dir: string, ctx?: InstanceContext) {
    const target = ctx ?? context.use()
    const resolved = AppFileSystem.resolve(dir)
    if (!target.allowedPaths) target.allowedPaths = []
    if (!target.allowedPaths.some((p) => AppFileSystem.resolve(p) === resolved)) {
      target.allowedPaths.push(resolved)
    }
    return target.allowedPaths
  },
  /**
   * Captures the current instance ALS context and returns a wrapper that
   * restores it when called. Use this for callbacks that fire outside the
   * instance async context (native addons, event emitters, timers, etc.).
   */
  bind<F extends (...args: any[]) => any>(fn: F): F {
    const ctx = context.use()
    return ((...args: any[]) => context.provide(ctx, () => fn(...args))) as F
  },
  /**
   * Run a synchronous function within the given instance context ALS.
   * Use this to bridge from Effect (where InstanceRef carries context)
   * back to sync code that reads Instance.directory from ALS.
   */
  restore<R>(ctx: InstanceContext, fn: () => R): R {
    return context.provide(ctx, fn)
  },
  async reload(input: { directory: string; init?: () => Promise<any>; project?: Project.Info; worktree?: string }) {
    const directory = AppFileSystem.resolve(input.directory)
    Log.Default.info("reloading instance", { directory })
    await disposeInstance(directory, input.project?.id)
    cache.delete(directory)
    const next = track(directory, boot({ ...input, directory }))

    GlobalBus.emit("event", {
      directory,
      project: input.project?.id,
      workspace: WorkspaceContext.workspaceID,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory,
        },
      },
    })

    return await next
  },
  async dispose() {
    const directory = Instance.directory
    const project = Instance.project
    Log.Default.info("disposing instance", { directory })
    await disposeInstance(directory, project.id)
    cache.delete(directory)

    GlobalBus.emit("event", {
      directory,
      project: project.id,
      workspace: WorkspaceContext.workspaceID,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory,
        },
      },
    })
  },
  /**
   * Dispose a cached instance by directory, callable from OUTSIDE any Instance
   * context. No-op when the directory has no cached instance. Because instance
   * bootstraps run fire-and-forget, the entry may not be registered yet when
   * the caller looks it up — `waitForMs` polls briefly (e.g. Worktree.remove
   * racing a just-forked bootstrap) so the disposal is not silently skipped.
   * Both the context resolution and the disposal are bounded by a timeout so a
   * hung bootstrap or disposer cannot block callers — on Windows, open watcher
   * handles make the subsequent `fs.rm` of the directory fail with EBUSY.
   */
  async disposeDirectory(directory: string, waitForMs = 0) {
    const resolved = AppFileSystem.resolve(directory)
    const deadline = Date.now() + waitForMs
    let pending = cache.get(resolved)
    while (!pending && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      pending = cache.get(resolved)
    }
    if (!pending) return
    const ctx = await withTimeout(
      pending.catch((error) => {
        Log.Default.warn("instance dispose failed", { directory: resolved, error })
        return undefined
      }),
      2000,
    ).catch((error) => {
      Log.Default.warn("instance resolve timed out, continuing disposal", { directory: resolved, error })
      return undefined
    })
    if (cache.get(resolved) === pending) cache.delete(resolved)
    if (!ctx) return
    await withTimeout(context.provide(ctx, () => Instance.dispose()), 2000).catch((error) => {
      Log.Default.warn("instance disposal timed out, continuing", { directory: resolved, error })
    })
  },

  async disposeAll() {
    if (disposal.all) return disposal.all

    disposal.all = iife(async () => {
      Log.Default.info("disposing all instances")
      const entries = [...cache.entries()]
      for (const [key, value] of entries) {
        if (cache.get(key) !== value) continue

        // Bound the context resolution AND the disposal itself: a never-
        // settling boot promise (or a hanging disposer) would otherwise stall
        // the entire shutdown loop with no upper bound.
        const ctx = await withTimeout(
          value.catch((error) => {
            Log.Default.warn("instance dispose failed", { key, error })
            return undefined
          }),
          2000,
        ).catch((error) => {
          Log.Default.warn("instance resolve timed out, continuing shutdown", { key, error })
          return undefined
        })

        if (!ctx) {
          if (cache.get(key) === value) cache.delete(key)
          continue
        }

        if (cache.get(key) !== value) continue

        // Bound each instance's disposal with a timeout so a single
        // blocking/never-resolving disposer (e.g. a hung child process or
        // a contended DB checkpoint) cannot stall the entire shutdown loop
        // and prevent the process from exiting gracefully.
        await withTimeout(
          context.provide(ctx, async () => {
            await withTimeout(Instance.dispose(), 2000).catch((error) => {
              Log.Default.warn("instance dispose timed out, continuing shutdown", { key, error })
            })
          }),
          2000,
        ).catch((error) => {
          Log.Default.warn("instance disposal timed out, continuing shutdown", { key, error })
        })
      }
    }).finally(() => {
      disposal.all = undefined
    })

    return disposal.all
  },
}
