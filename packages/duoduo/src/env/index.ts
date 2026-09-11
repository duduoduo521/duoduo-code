import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect"

type State = Record<string, string | undefined>

export interface Interface {
  readonly get: (key: string) => Effect.Effect<string | undefined>
  readonly all: () => Effect.Effect<State>
  readonly set: (key: string, value: string) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/Env") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(Effect.fn("Env.state")(() => Effect.succeed({ ...process.env })))

    const get = Effect.fn("Env.get")((key: string) => InstanceState.use(state, (env) => env[key]))
    const all = Effect.fn("Env.all")(() => InstanceState.get(state))
    const set = Effect.fn("Env.set")(function* (key: string, value: string) {
      const env = yield* InstanceState.get(state)
      env[key] = value
      // Write through to the real process.env as well. The in-memory snapshot is
      // initialized from `{ ...process.env }`, so process.env is always a superset of
      // the snapshot; keeping the two in sync lets code that reads `process.env`
      // directly (e.g. provider credential lookups) observe values injected via Env.set.
      process.env[key] = value
    })
    const remove = Effect.fn("Env.remove")(function* (key: string) {
      const env = yield* InstanceState.get(state)
      delete env[key]
      delete process.env[key]
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer

export * as Env from "."
