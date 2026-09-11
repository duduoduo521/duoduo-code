/** @effect-diagnostics runEffectInsideEffect:skip-file */
import { Effect, Fiber, ScopedCache, Scope, Context, Duration, Exit } from "effect"
import * as EffectLogger from "./logger"
import { Log } from "@/util"
import { Instance, type InstanceContext } from "@/project/instance"
import { LocalContext } from "@/util"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~duoduo/InstanceState"

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
}

export const bind = <F extends (...args: any[]) => any>(fn: F): F => {
  try {
    return Instance.bind(fn)
  } catch (err) {
    if (!(err instanceof LocalContext.NotFound)) throw err
  }
  const fiber = Fiber.getCurrent()
  const ctx = fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
  if (!ctx) return fn
  return ((...args: any[]) => Instance.restore(ctx, () => fn(...args))) as F
}

export const context = Effect.gen(function* () {
  return (yield* InstanceRef) ?? Instance.current
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const cache = yield* ScopedCache.makeWith<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      timeToLive: (exit: Exit.Exit<A, E>) => {
        // Failed lookups expire quickly so they can be retried.
        // Successful entries live indefinitely.
        if (exit._tag === "Failure") return Duration.seconds(5)
        return Duration.infinity
      },
      lookup: (key: string) =>
// @effect-diagnostics-next-line unnecessaryEffectGen:off
        Effect.gen(function* () {
          return yield* init(yield* context)
        }),
    })

    const off = registerDisposer(async (directory) => {
      try {
        await Effect.runPromise(ScopedCache.invalidate(cache, directory).pipe(Effect.provide(EffectLogger.layer)))
      } catch {
        // ScopedCache may be closed if AppRuntime was disposed; ignore.
      }
    })
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
// @effect-diagnostics-next-line unnecessaryEffectGen:off
  Effect.gen(function* () {
    return yield* ScopedCache.get(self.cache, yield* directory)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
// @effect-diagnostics-next-line unnecessaryEffectGen:off
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, yield* directory)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
// @effect-diagnostics-next-line unnecessaryEffectGen:off
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, yield* directory)
  })
