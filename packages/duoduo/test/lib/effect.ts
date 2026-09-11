import { test, type TestOptions } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import type * as Scope from "effect/Scope"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"

// Effect v4 beta: Effect.gen infers R as `unknown` in many cases.
// We use `unknown` in Body/run types to avoid `unknown not assignable to never` errors.
type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)

const body = <A, E, R>(value: Body<A, E, R>) => Effect.suspend(() => (typeof value === "function" ? value() : value))

const run = <A, E, R, E2>(value: Body<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2, unknown>) =>
  Effect.gen(function* () {
    const exit = yield* (body(value)).pipe(
      Effect.scoped,
      Effect.provide(layer as Layer.Layer<R, E2>),
      Effect.exit,
    )
    if (Exit.isFailure(exit)) {
      for (const err of Cause.prettyErrors(exit.cause)) {
        yield* Effect.logError(err)
      }
    }
    return yield* exit
  }).pipe(Effect.runPromise)

const make = <R, E>(testLayer: Layer.Layer<R, E, unknown>, liveLayer: Layer.Layer<R, E, unknown>) => {
  // oxlint-disable-next-line no-redundant-type-constituents -- unknown is intentionally widened to accept any Effect context
  const effect = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope | unknown>, opts?: number | TestOptions) =>
    test(name, () => run(value as Body<A, E2, R | Scope.Scope>, testLayer), opts)

  // oxlint-disable-next-line no-redundant-type-constituents -- unknown is intentionally widened to accept any Effect context
  effect.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope | unknown>, opts?: number | TestOptions) =>
    test.only(name, () => run(value as Body<A, E2, R | Scope.Scope>, testLayer), opts)

  // oxlint-disable-next-line no-redundant-type-constituents -- unknown is intentionally widened to accept any Effect context
  effect.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope | unknown>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value as Body<A, E2, R | Scope.Scope>, testLayer), opts)

  // oxlint-disable-next-line no-redundant-type-constituents -- unknown is intentionally widened to accept any Effect context
  const live = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope | unknown>, opts?: number | TestOptions) =>
    test(name, () => run(value as Body<A, E2, R | Scope.Scope>, liveLayer), opts)

  // oxlint-disable-next-line no-redundant-type-constituents -- unknown is intentionally widened to accept any Effect context
  live.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope | unknown>, opts?: number | TestOptions) =>
    test.only(name, () => run(value as Body<A, E2, R | Scope.Scope>, liveLayer), opts)

  // oxlint-disable-next-line no-redundant-type-constituents -- unknown is intentionally widened to accept any Effect context
  live.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope | unknown>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value as Body<A, E2, R | Scope.Scope>, liveLayer), opts)

  // Mirrors bun's `test.skipIf(condition)`: returns a test registrar that skips
  // when `condition` is true. Used to gate integration-style tests that require
  // an external dependency (e.g. the Rust smart-layer run loop) so the regular
  // unit suite does not fail when that dependency is absent.
  live.skipIf = (condition: boolean) =>
    condition ? live.skip : live

  // oxlint-disable-next-line no-redundant-type-constituents -- unknown is intentionally widened to accept any Effect context
  effect.skipIf = (condition: boolean) =>
    condition ? effect.skip : effect

  return { effect, live }
}

// Test environment with TestClock and TestConsole
const testEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())

// Live environment - uses real clock, but keeps TestConsole for output capture
const liveEnv = TestConsole.layer

export const it = make(testEnv as Layer.Layer<never, never>, liveEnv as Layer.Layer<never, never>)

export const testEffect = <R, E>(layer: Layer.Layer<R, E, unknown>) =>
  make(
    Layer.provideMerge(layer, testEnv) as Layer.Layer<R, never, unknown>,
    Layer.provideMerge(layer, liveEnv) as Layer.Layer<R, never, unknown>,
  )
