import { Effect, Layer, ManagedRuntime } from "effect"
import * as Context from "effect/Context"
import { Instance } from "@/project/instance"
import { LocalContext } from "@/util"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import * as Observability from "./observability"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import type { InstanceContext } from "@/project/instance"

type Refs = {
  instance?: InstanceContext
  workspace?: string
}

export function attachWith<A, E, R>(effect: Effect.Effect<A, E, R>, refs: Refs): Effect.Effect<A, E, R> {
  if (!refs.instance && !refs.workspace) return effect
  if (!refs.instance) return effect.pipe(Effect.provideService(WorkspaceRef, refs.workspace))
  if (!refs.workspace) return effect.pipe(Effect.provideService(InstanceRef, refs.instance))
  return effect.pipe(
    Effect.provideService(InstanceRef, refs.instance),
    Effect.provideService(WorkspaceRef, refs.workspace),
  )
}

export function attach<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  try {
    return attachWith(effect, {
      instance: Instance.current,
      workspace: WorkspaceContext.workspaceID,
    })
  } catch (err) {
    if (!(err instanceof LocalContext.NotFound)) throw err
    // ALS context is not available — InstanceRef will be undefined.
    // This is expected when running outside of Instance.provide() (e.g. CLI
    // startup, global operations). Downstream code that uses InstanceState
    // will fail with "Service not found" if it tries to access per-directory
    // state, which is handled by Instance.provide's retry logic.
  }
  return effect
}

// A single shared memo map ensures that the same Layer is built only once
// across all makeRuntime instances, so dependent layers are reused rather
// than reconstructed.
const sharedMemoMap = Layer.makeMemoMapUnsafe()

export function makeRuntime<I, S, E, R>(service: Context.Service<I, S>, layer: Layer.Layer<I, E, R>) {
  let rt: ManagedRuntime.ManagedRuntime<I, E> | undefined
  // Track whether the runtime has successfully built its context at least once.
  // A disposed ManagedRuntime has cachedContext=undefined and
  // contextEffect replaced with Effect.die, causing all
  // subsequent run* calls to fail rather than rebuild.
  let contextBuilt = false
  const getRuntime = () => {
    if (rt && contextBuilt) {
      // If cachedContext was cleared (e.g. after dispose()),
      // the runtime is stale and must be recreated.
      try {
        // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
        rt.context()
      } catch {
        rt = undefined
        contextBuilt = false
      }
    }
    const runtime = (rt ??= ManagedRuntime.make(Layer.provideMerge(layer as Layer.Layer<I, E>, Observability.layer), {
      memoMap: sharedMemoMap,
    }))
    if (runtime["cachedContext"] !== undefined) {
      contextBuilt = true
    }
    return runtime
  }

  return {
    runSync: <A, Err, R>(fn: (svc: S) => Effect.Effect<A, Err, R>) =>
      getRuntime().runSync(attach(service.use(fn)) as Effect.Effect<A, Err, I>),
    runPromiseExit: <A, Err, R>(fn: (svc: S) => Effect.Effect<A, Err, R>, options?: Effect.RunOptions) =>
      getRuntime().runPromiseExit(attach(service.use(fn)) as Effect.Effect<A, Err, I>, options),
    runPromise: <A, Err, R>(fn: (svc: S) => Effect.Effect<A, Err, R>, options?: Effect.RunOptions) =>
      getRuntime().runPromise(attach(service.use(fn)) as Effect.Effect<A, Err, I>, options),
    runFork: <A, Err, R>(fn: (svc: S) => Effect.Effect<A, Err, R>) =>
      getRuntime().runFork(attach(service.use(fn)) as Effect.Effect<A, Err, I>),
    runCallback: <A, Err, R>(fn: (svc: S) => Effect.Effect<A, Err, R>) =>
      getRuntime().runCallback(attach(service.use(fn)) as Effect.Effect<A, Err, I>),
  }
}
