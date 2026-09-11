import { Observability } from "./observability"
import { Layer, type Context, ManagedRuntime, type Effect } from "effect"

export function makeRuntime<I, S, E>(service: Context.Service<I, S>, layer: Layer.Layer<I, E>) {
  // Each makeRuntime instance uses its own memoMap to prevent
  // cross-runtime Scope contamination. When AppRuntime is
  // disposed/rebuilt, a shared memoMap would retain stale Scope
  // references that poison all other runtimes.
  const localMemoMap = Layer.makeMemoMapUnsafe()
  let rt: ManagedRuntime.ManagedRuntime<I, E> | undefined
  const getRuntime = () =>
    (rt ??= ManagedRuntime.make(Layer.provideMerge(layer, Observability.layer), {
      memoMap: localMemoMap,
    }))

  return {
    runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runSync(service.use(fn)),
    runPromiseExit: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromiseExit(service.use(fn), options),
    runPromise: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromise(service.use(fn), options),
    runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runFork(service.use(fn)),
    runCallback: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runCallback(service.use(fn)),
  }
}
