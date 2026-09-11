import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { uniqueBy } from "remeda"
import { createSimpleContext } from "@duoduo-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Store = {
  recent: ModelKey[]
  effort?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

/** Migrate v1 data (which may contain a stale `user` visibility array) to v2 shape. */
function migrateV1(value: unknown): unknown {
  if (!value || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  // Strip the deprecated `user` array that stored per-model visibility state
  const { user: _, ...rest } = record
  return rest
}

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  init: () => {
    const providers = useProviders()

    const [store, setStore, _, ready] = persisted(
      { ...Persist.global("model.v2", ["model.v1"]), migrate: migrateV1 },
      createStore<Store>({
        recent: [],
        effort: {},
      }),
    )

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const effortKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getEffort = (model: ModelKey) => store.effort?.[effortKey(model)]
    const setEffort = (model: ModelKey, value: string | undefined) => {
      const key = effortKey(model)
      if (!store.effort) {
        setStore("effort", { [key]: value })
        return
      }
      setStore("effort", key, value)
    }

    return {
      ready,
      list,
      find,
      recent: {
        list: createMemo(() => store.recent),
        push,
      },
      effort: {
        get: getEffort,
        set: setEffort,
      },
    }
  },
})
