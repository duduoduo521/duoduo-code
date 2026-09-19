import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@duoduo-ai/shared/util/binary"
import { retry } from "@duoduo-ai/shared/util/retry"
import { createSimpleContext } from "@duoduo-ai/ui/context"
import {
  clearSessionPrefetch,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  setSessionPrefetch,
} from "./global-sync/session-prefetch"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import type { Message, Part } from "@duoduo-ai/sdk/v2/client"
import { SESSION_CACHE_LIMIT, dropSessionCaches, pickSessionCacheEvictions } from "./global-sync/session-cache"
import { diffs as list, message as clean } from "@/utils/diffs"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

// Keyed union of cached + incoming messages. Server (`incoming`) values win on id
// conflict. Used by loadMessages replace mode so a (possibly limited) server page
// never deletes messages the store already holds — e.g. ones delivered earlier via
// SSE, which can grow the store beyond `meta.limit[key]` without updating it.
function unionMessagesById(cached: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>()
  for (const m of cached) if (m?.id) byId.set(m.id, m)
  for (const m of incoming) {
    if (!m?.id) continue
    const prev = byId.get(m.id)
    // Keep a locally-applied abort marker. The frontend marks the in-flight
    // assistant message as "stopped by user" the instant Stop is pressed, which
    // can run ahead of the server persisting the same marker on that row.
    // Letting the not-yet-updated server row win would erase the only feedback
    // the user gets from that click.
    const aborted = prev?.role === "assistant" ? prev.error : undefined
    if (aborted && m.role === "assistant" && !m.error) {
      byId.set(m.id, { ...m, error: aborted })
      continue
    }
    byId.set(m.id, m)
  }
  return [...byId.values()].sort((a, b) => cmp(a.id, b.id))
}

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    map.delete(key)
  })
  map.set(key, promise)
  return promise
}

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function merge<T extends { id: string }>(a: readonly T[], b: readonly T[]) {
  const map = new Map(a.map((item) => [item.id, item] as const))
  for (const item of b) map.set(item.id, item)
  return [...map.values()].sort((x, y) => cmp(x.id, y.id))
}

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

type OptimisticItem = {
  message: Message
  parts: Part[]
}

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return want.length === 0
  return want.every((part) => Binary.search(parts, part.id, (item) => item.id).found)
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return sortParts(want)
  const next = [...parts]
  let changed = false
  for (const part of want) {
    const result = Binary.search(next, part.id, (item) => item.id)
    if (result.found) continue
    next.splice(result.index, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    const result = Binary.search(session, item.message.id, (message) => message.id)
    const found = result.found
    if (!found) session.splice(result.index, 0, item.message)

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    messages.splice(result.index, 0, input.message)
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (result.found) messages.splice(result.index, 1)
  }
  delete draft.part[input.messageID]
}

function setOptimisticAdd(setStore: (...args: unknown[]) => void, input: OptimisticAddInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return [input.message]
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    const next = [...messages]
    next.splice(result.index, 0, input.message)
    return next
  })
  setStore("part", input.message.id, sortParts(input.parts))
}

function setOptimisticRemove(setStore: (...args: unknown[]) => void, input: OptimisticRemoveInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return messages
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (!result.found) return messages
    const next = [...messages]
    next.splice(result.index, 1)
    return next
  })
  setStore("part", (part: Record<string, Part[] | undefined>) => {
    if (!(input.messageID in part)) return part
    const next = { ...part }
    delete next[input.messageID]
    return next
  })
}

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()

    type Child = ReturnType<(typeof globalSync)["child"]>
    type Setter = Child[1]

    const current = createMemo(() => globalSync.child(sdk.directory))
    const target = (directory?: string) => {
      if (!directory || directory === sdk.directory) return current()
      return globalSync.child(directory)
    }
    const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
    const initialMessagePageSize = 80
    const historyMessagePageSize = 200
    const inflight = new Map<string, Promise<void>>()
    const inflightDiff = new Map<string, Promise<void>>()
    const inflightTodo = new Map<string, Promise<void>>()
    const inflightParts = new Map<string, Promise<void>>()
    const optimistic = new Map<string, Map<string, OptimisticItem>>()
    const maxDirs = 30
    const seen = new Map<string, Set<string>>()
    const [meta, setMeta] = createStore({
      limit: {} as Record<string, number>,
      cursor: {} as Record<string, string | undefined>,
      complete: {} as Record<string, boolean>,
      loading: {} as Record<string, boolean>,
    })

    // Restore seen and meta from existing child store after Provider rebuild
    // (e.g. navigating away and back). This prevents tracked() from discarding
    // loadMessages results and allows cached messages to be used directly.
    const existingStore = current()[0]
    const existingSessionIDs = existingStore.session.map((s) => s.id)
    if (existingSessionIDs.length > 0) {
      seen.set(sdk.directory, new Set(existingSessionIDs))
      for (const sessionID of existingSessionIDs) {
        const seeded = getSessionPrefetch(sdk.directory, sessionID)
        if (seeded && existingStore.message[sessionID] !== undefined) {
          const key = keyFor(sdk.directory, sessionID)
          batch(() => {
            setMeta("limit", key, seeded.limit)
            setMeta("cursor", key, seeded.cursor)
            setMeta("complete", key, seeded.complete)
            setMeta("loading", key, false)
          })
        }
      }
    }

    const getSession = (sessionID: string) => {
      const store = current()[0]
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (match.found) return store.session[match.index]
      return undefined
    }

    const setOptimistic = (directory: string, sessionID: string, item: OptimisticItem) => {
      const key = keyFor(directory, sessionID)
      const list = optimistic.get(key)
      if (list) {
        list.set(item.message.id, { message: item.message, parts: sortParts(item.parts) })
        return
      }
      optimistic.set(key, new Map([[item.message.id, { message: item.message, parts: sortParts(item.parts) }]]))
    }

    const clearOptimistic = (directory: string, sessionID: string, messageID?: string) => {
      const key = keyFor(directory, sessionID)
      if (!messageID) {
        optimistic.delete(key)
        return
      }

      const list = optimistic.get(key)
      if (!list) return
      list.delete(messageID)
      if (list.size === 0) optimistic.delete(key)
    }

    const getOptimistic = (directory: string, sessionID: string) => [
      ...(optimistic.get(keyFor(directory, sessionID))?.values() ?? []),
    ]

    const seenFor = (directory: string) => {
      const existing = seen.get(directory)
      if (existing) {
        seen.delete(directory)
        seen.set(directory, existing)
        return existing
      }
      const created = new Set<string>()
      seen.set(directory, created)
      while (seen.size > maxDirs) {
        const first = seen.keys().next().value
        if (!first) break
        const stale = [...(seen.get(first) ?? [])]
        seen.delete(first)
        const [, setStore] = globalSync.child(first, { bootstrap: false })
        evict(first, setStore, stale)
      }
      return created
    }

    const clearMeta = (directory: string, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      for (const sessionID of sessionIDs) {
        clearOptimistic(directory, sessionID)
      }
      setMeta(
        produce((draft) => {
          for (const sessionID of sessionIDs) {
            const key = keyFor(directory, sessionID)
            delete draft.limit[key]
            delete draft.cursor[key]
            delete draft.complete[key]
            delete draft.loading[key]
          }
        }),
      )
    }

    const evict = (directory: string, setStore: Setter, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      clearSessionPrefetch(directory, sessionIDs)
      for (const sessionID of sessionIDs) {
        globalSync.todo.set(sessionID, undefined)
      }
      setStore(
        produce((draft) => {
          dropSessionCaches(draft, sessionIDs)
        }),
      )
      clearMeta(directory, sessionIDs)
    }

    const touch = (directory: string, setStore: Setter, sessionID: string, preserve: string[] = []) => {
      const stale = pickSessionCacheEvictions({
        seen: seenFor(directory),
        keep: sessionID,
        limit: SESSION_CACHE_LIMIT,
        preserve,
      })
      evict(directory, setStore, stale)
    }

    const fetchMessages = async (input: {
      client: typeof sdk.client
      sessionID: string
      limit: number
      before?: string
    }) => {
      const messages = await retry(() =>
        input.client.session.messages({ sessionID: input.sessionID, limit: input.limit, before: input.before }),
      )
      const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
      const session = items.map((x) => clean(x.info)).sort((a, b) => cmp(a.id, b.id))
      const part = items.map((message) => ({ id: message.info.id, part: sortParts(message.parts) }))
      const cursor = messages.response.headers.get("x-next-cursor") ?? undefined
      return {
        session,
        part,
        cursor,
        complete: !cursor,
      }
    }

    const tracked = (directory: string, sessionID: string) => seen.get(directory)?.has(sessionID) ?? false

    const loadParts = (sessionID: string, messageID: string): Promise<void> => {
      // 兼容旧版 Rust runLoop：早期版本在流式阶段用裸 ULID 作为 assistant message
      // 的临时占位 ID（pre_assistant_msg_id，见 crates/duo-smart-layer/src/routes/agent.rs），
      // 经 SSE delta/thinking 推给前端。该 ULID 不含 "msg" 前缀，且尚未被 TS 落库为正式
      // MessageID（msg_xxx）。session.message 端点的 messageID 参数要求 ^msg.*，用 ULID
      // 调用会在参数校验阶段直接失败（invalid_format）；且流式阶段的 parts 已由 SSE delta
      // 实时累积进本地 store，无需回源拉取，故跳过此类占位 ID。
      // 注意：当前 Rust 已把占位 ID 改为 new_message_id()（msg_ 前缀，见 agent.rs:3904），
      // 不再命中此分支；此处保留仅为向后兼容旧版构建 / 回滚场景。
      if (!messageID.startsWith("msg")) return Promise.resolve()
      return runInflight(inflightParts, messageID, async () => {
        const directory = sdk.directory
        const response = await retry(() => sdk.client.session.message({ sessionID, messageID }))
        if (!tracked(directory, sessionID)) {
          // The session may have been evicted from `seen` during the async
          // wait (e.g. by another touch()). Re-touch and re-check once so the
          // already-fetched parts aren't silently discarded — mirroring the
          // eviction-retry guard in sync.session.sync.
          const [, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          if (!tracked(directory, sessionID)) return
        }
        const parts = sortParts(response.data?.parts ?? [])
        const filtered = parts.filter((x) => !SKIP_PARTS.has(x.type))
        if (filtered.length) {
          const [, setStore] = globalSync.child(directory)
          setStore("part", messageID, reconcile(filtered, { key: "id" }))
        }
      })
    }

    const loadMessages = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      limit: number
      before?: string
      mode?: "replace" | "prepend"
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      if (meta.loading[key]) return

      setMeta("loading", key, true)
      await fetchMessages(input)
        .then((page) => {
          if (!tracked(input.directory, input.sessionID)) return
          const next = mergeOptimisticPage(page, getOptimistic(input.directory, input.sessionID))
          for (const messageID of next.confirmed) {
            clearOptimistic(input.directory, input.sessionID, messageID)
          }
          const [store] = globalSync.child(input.directory, { bootstrap: false })
          const cached = store.message[input.sessionID] ?? []
          // Replace mode must not drop store messages that are absent from the
          // (possibly limited) server page. SSE can grow the store beyond
          // `meta.limit[key]`, so a hard `reconcile` of just `next.session` would
          // delete valid messages (including the user's first message) after a force
          // sync. Merge keyed by id instead; server values win on conflict.
          const message =
            input.mode === "prepend"
              ? merge(cached, next.session)
              : unionMessagesById(cached, next.session)
          batch(() => {
            input.setStore("message", input.sessionID, reconcile(message, { key: "id" }))
            // Initial load (replace) stores parts together to avoid first-paint blank.
            // History load (prepend) skips parts — they are loaded on demand by the
            // parts windowing effect in message-timeline when messages enter the viewport.
            if (input.mode !== "prepend") {
              for (const p of next.part) {
                const filtered = p.part.filter((x) => !SKIP_PARTS.has(x.type))
                if (filtered.length) input.setStore("part", p.id, filtered)
              }
            }
            setMeta("limit", key, message.length)
            setMeta("cursor", key, next.cursor)
            setMeta("complete", key, next.complete)
            setSessionPrefetch({
              directory: input.directory,
              sessionID: input.sessionID,
              limit: message.length,
              cursor: next.cursor,
              complete: next.complete,
            })
          })
        })
        .finally(() => {
          setMeta(
            produce((draft) => {
              if (!tracked(input.directory, input.sessionID)) {
                delete draft.loading[key]
                return
              }
              draft.loading[key] = false
            }),
          )
        })
    }

    return {
      get data() {
        return current()[0]
      },
      get set(): Setter {
        return current()[1]
      },
      get status() {
        return current()[0].status
      },
      get ready() {
        return current()[0].status !== "loading"
      },
      get project() {
        const store = current()[0]
        const match = Binary.search(globalSync.data.project, store.project, (p) => p.id)
        if (match.found) return globalSync.data.project[match.index]
        return undefined
      },
      session: {
        get: getSession,
        optimistic: {
          add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
            const directory = input.directory ?? sdk.directory
            const [, setStore] = target(input.directory)
            setOptimistic(directory, input.sessionID, { message: input.message, parts: input.parts })
            setOptimisticAdd(setStore as (...args: unknown[]) => void, input)
          },
          remove(input: { directory?: string; sessionID: string; messageID: string }) {
            const directory = input.directory ?? sdk.directory
            const [, setStore] = target(input.directory)
            clearOptimistic(directory, input.sessionID, input.messageID)
            setOptimisticRemove(setStore as (...args: unknown[]) => void, input)
          },
        },
        addOptimisticMessage(input: {
          sessionID: string
          messageID: string
          parts: Part[]
          agent: string
          model: { providerID: string; modelID: string }
        }) {
          const message: Message = {
            id: input.messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.agent,
            model: { ...input.model },
          }
          const [, setStore] = target()
          setOptimistic(sdk.directory, input.sessionID, { message, parts: input.parts })
          setOptimisticAdd(setStore as (...args: unknown[]) => void, {
            sessionID: input.sessionID,
            message,
            parts: input.parts,
          })
        },
        async sync(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          const key = keyFor(directory, sessionID)

          touch(
            directory,
            setStore,
            sessionID,
            (() => {
              const match = Binary.search(store.session, sessionID, (s) => s.id)
              const parentID = match.found ? store.session[match.index]?.parentID : undefined
              return parentID ? [parentID] : []
            })(),
          )

          const seeded = getSessionPrefetch(directory, sessionID)
          if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
            batch(() => {
              setMeta("limit", key, seeded.limit)
              setMeta("cursor", key, seeded.cursor)
              setMeta("complete", key, seeded.complete)
              setMeta("loading", key, false)
            })
          }

          return runInflight(inflight, key, async () => {
            const pending = getSessionPrefetchPromise(directory, sessionID)
            if (pending) {
              await pending
              const seeded = getSessionPrefetch(directory, sessionID)
              if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
                batch(() => {
                  setMeta("limit", key, seeded.limit)
                  setMeta("cursor", key, seeded.cursor)
                  setMeta("complete", key, seeded.complete)
                  setMeta("loading", key, false)
                })
              }
            }

            const hasSession = Binary.search(store.session, sessionID, (s) => s.id).found
            const cached = store.message[sessionID] !== undefined && meta.limit[key] !== undefined
            if (cached && hasSession && !opts?.force) return

            const limit = meta.limit[key] ?? initialMessagePageSize
            const sessionReq =
              hasSession && !opts?.force
                ? Promise.resolve()
                : retry(() => client.session.get({ sessionID })).then((session) => {
                    if (!tracked(directory, sessionID)) return
                    const data = session.data
                    if (!data) return
                    setStore(
                      "session",
                      produce((draft) => {
                        const match = Binary.search(draft, sessionID, (s) => s.id)
                        if (match.found) {
                          draft[match.index] = data
                          return
                        }
                        draft.splice(match.index, 0, data)
                      }),
                    )
                  })

            const messagesReq =
              cached && !opts?.force
                ? Promise.resolve()
                : loadMessages({
                    directory,
                    client,
                    setStore,
                    sessionID,
                    limit,
                  })

            await Promise.all([sessionReq, messagesReq])

            // Retry guard: if the session was evicted from `seen` during the async
            // wait (e.g. by another touch() call), loadMessages' then-callback would
            // have skipped writing to the store. Re-touch and retry once to recover.
            if (!tracked(directory, sessionID) && store.message[sessionID] === undefined) {
              touch(directory, setStore, sessionID)
              await loadMessages({ directory, client, setStore, sessionID, limit })
              if (store.message[sessionID] === undefined) {
                console.warn(`[sync] session ${sessionID} messages still undefined after retry`)
              }
            }
          })
        },
        async diff(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          if (store.session_diff[sessionID] !== undefined && !opts?.force) return

          const key = keyFor(directory, sessionID)
          return runInflight(inflightDiff, key, () =>
            retry(() => client.session.diff({ sessionID })).then((diff) => {
              if (!tracked(directory, sessionID)) return
              setStore("session_diff", sessionID, reconcile(list(diff.data), { key: "file" }))
            }),
          )
        },
        async todo(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          const existing = store.todo[sessionID]
          const cached = globalSync.data.session_todo[sessionID]
          if (existing !== undefined) {
            if (cached === undefined) {
              globalSync.todo.set(sessionID, existing)
            }
            if (!opts?.force) return
          }

          if (cached !== undefined) {
            setStore("todo", sessionID, reconcile(cached, { key: "id" }))
          }

          const key = keyFor(directory, sessionID)
          return runInflight(inflightTodo, key, () =>
            retry(() => client.session.todo({ sessionID })).then((todo) => {
              if (!tracked(directory, sessionID)) return
              const list = todo.data ?? []
              setStore("todo", sessionID, reconcile(list, { key: "id" }))
              globalSync.todo.set(sessionID, list)
            }),
          )
        },
        history: {
          more(sessionID: string) {
            const store = current()[0]
            const key = keyFor(sdk.directory, sessionID)
            if (store.message[sessionID] === undefined) return false
            if (meta.limit[key] === undefined) return false
            if (meta.complete[key]) return false
            return !!meta.cursor[key]
          },
          loading(sessionID: string) {
            const key = keyFor(sdk.directory, sessionID)
            return meta.loading[key] ?? false
          },
          async loadMore(sessionID: string, count?: number) {
            const directory = sdk.directory
            const client = sdk.client
            const [, setStore] = globalSync.child(directory)
            touch(directory, setStore, sessionID)
            const key = keyFor(directory, sessionID)
            const step = count ?? historyMessagePageSize
            if (meta.loading[key]) return
            if (meta.complete[key]) return
            const before = meta.cursor[key]
            if (!before) return

            await loadMessages({
              directory,
              client,
              setStore,
              sessionID,
              limit: step,
              before,
              mode: "prepend",
            })
          },
        },
        evict(sessionID: string, directory = sdk.directory) {
          const [, setStore] = globalSync.child(directory)
          seenFor(directory).delete(sessionID)
          evict(directory, setStore, [sessionID])
        },
        fetch: async (count = 10) => {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          setStore("limit", (x) => x + count)
          await client.session.list().then((x) => {
            const sessions = (x.data ?? [])
              .filter((s) => !!s?.id)
              .sort((a, b) => cmp(a.id, b.id))
              .slice(0, store.limit)
            setStore("session", reconcile(sessions, { key: "id" }))
          })
        },
        more: createMemo(() => current()[0].session.length >= current()[0].limit),
        archive: async (sessionID: string) => {
          const directory = sdk.directory
          const client = sdk.client
          const [, setStore] = globalSync.child(directory)
          await client.session.update({ sessionID, time: { archived: Date.now() } })
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session.splice(match.index, 1)
            }),
          )
        },
      },
      parts: {
        load: loadParts,
      },
      absolute,
      get directory() {
        return current()[0].path.directory
      },
    }
  },
})
