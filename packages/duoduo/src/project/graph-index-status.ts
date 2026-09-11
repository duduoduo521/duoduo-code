import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect"
import { Effect, Layer, Context } from "effect"
import z from "zod"

export const Info = z
  .union([
    z.object({
      type: z.literal("idle"),
    }),
    z.object({
      type: z.literal("indexing"),
      progress: z.number().optional(),
      filesDone: z.number().optional(),
      filesTotal: z.number().optional(),
    }),
    z.object({
      type: z.literal("ready"),
    }),
    z.object({
      type: z.literal("failed"),
      error: z.string().optional(),
    }),
  ])
  .meta({
    ref: "GraphIndexStatus",
  })
export type Info = z.infer<typeof Info>

export const Event = {
  Status: BusEvent.define(
    "graph.index-status",
    z.object({
      status: Info,
    }),
  ),
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly set: (status: Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/GraphIndexStatus") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    // Per-instance (per-directory) mutable holder. InstanceState.make
    // caches by directory via ScopedCache, so each project gets its own
    // { value: Info } object. Mutations are visible to subsequent gets
    // because ScopedCache returns the same object reference.
    const state = yield* InstanceState.make(
      Effect.fn("GraphIndexStatus.state")(() => Effect.succeed<{ value: Info }>({ value: { type: "idle" } })),
    )

    const get = Effect.fn("GraphIndexStatus.get")(function* () {
      const ref = yield* InstanceState.get(state)
      return ref.value
    })

    const set = Effect.fn("GraphIndexStatus.set")(function* (status: Info) {
      const ref = yield* InstanceState.get(state)
      ref.value = status
// @effect-diagnostics-next-line catchUnfailableEffect:off
      yield* bus.publish(Event.Status, { status }).pipe(Effect.catch(() => Effect.void))
    })

    return Service.of({ get, set })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as GraphIndexStatus from "./graph-index-status"
