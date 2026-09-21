import { Binary } from "@duoduo-ai/shared/util/binary"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type {
  Message,
  Part,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
} from "@duoduo-ai/sdk/v2/client"
import type { State, VcsCache, GraphIndexInfo } from "./types"
import { trimSessions } from "./session-trim"
import { dropSessionCaches } from "./session-cache"
import { diffs as list, message as clean } from "@/utils/diffs"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

/**
 * Preserve TS-side `ctx.metadata()` values (e.g. task sub-session id) that the
 * Rust completed/error state would otherwise wipe via `reconcile` (metadata: {}).
 *
 * When the incoming tool part carries an empty `metadata` but the already-stored
 * part has a non-empty one, we copy the existing metadata onto the incoming part
 * before the caller reconciles. If the incoming part already has real metadata,
 * it wins (no clobbering). Non-tool parts are ignored.
 */
export function preserveToolMetadata(existing: Part | undefined, part: Part): void {
  if (part.type !== "tool") return
  const incomingMeta = (part.state as { metadata?: Record<string, unknown> } | undefined)?.metadata
  const existingMeta = ((existing as { state?: { metadata?: Record<string, unknown> } } | undefined)?.state)
    ?.metadata
  const incomingEmpty = !incomingMeta || Object.keys(incomingMeta).length === 0
  if (incomingEmpty && existingMeta && Object.keys(existingMeta).length > 0) {
    ;(part.state as { metadata?: Record<string, unknown> }).metadata = {
      ...existingMeta,
      ...incomingMeta,
    }
  }
}

export function applyGlobalEvent(input: {
  event: { type: string; properties?: unknown }
  project: Project[]
  setGlobalProject: (next: Project[] | ((draft: Project[]) => Project[])) => void
  refresh: () => void
}) {
  if (input.event.type === "global.disposed" || input.event.type === "server.connected") {
    input.refresh()
    return
  }

  if (input.event.type !== "project.updated") return
  const properties = input.event.properties as Project
  const result = Binary.search(input.project, properties.id, (s) => s.id)
  if (result.found) {
    input.setGlobalProject(
      produce((draft) => {
        draft[result.index] = { ...draft[result.index], ...properties }
      }),
    )
    return
  }
  input.setGlobalProject(
    produce((draft) => {
      draft.splice(result.index, 0, properties)
    }),
  )
}

function cleanupSessionCaches(
  setStore: SetStoreFunction<State>,
  sessionID: string,
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
) {
  if (!sessionID) return
  setSessionTodo?.(sessionID, undefined)
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, [sessionID])
    }),
  )
}

export function cleanupDroppedSessionCaches(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  next: Session[],
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
) {
  const keep = new Set(next.map((item) => item.id))
  // Protect parent sessions that have active child sessions in the list.
  // This prevents cleanupDroppedSessionCaches from clearing a parent's caches
  // while a child session is still active (e.g. user navigated into a subagent session).
  const activeParents = new Set(next.filter((s) => s.parentID).map((s) => s.parentID!))
  const isProtected = (sessionID: string) => keep.has(sessionID) || activeParents.has(sessionID)
  const stale = [
    ...Object.keys(store.message),
    ...Object.keys(store.session_diff),
    ...Object.keys(store.todo),
    ...Object.keys(store.permission),
    ...Object.keys(store.question),
    ...Object.keys(store.session_status),
    ...Object.values(store.part)
      .map((parts) => parts?.find((part) => !!part?.sessionID)?.sessionID)
      .filter((sessionID): sessionID is string => !!sessionID),
  ].filter((sessionID, index, list) => !isProtected(sessionID) && list.indexOf(sessionID) === index)
  if (stale.length === 0) return
  for (const sessionID of stale) {
    setSessionTodo?.(sessionID, undefined)
  }
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, stale)
    }),
  )
}

export function applyDirectoryEvent(input: {
  event: { type: string; properties?: unknown }
  store: Store<State>
  setStore: SetStoreFunction<State>
  push: (directory: string) => void
  directory: string
  loadLsp: () => void
  refreshMcp: () => void
  vcsCache?: VcsCache
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void
  isAborted?: (sessionID: string) => boolean
}) {
  const event = input.event
  switch (event.type) {
    case "server.instance.disposed": {
      // Do NOT re-bootstrap a disposed directory. The only emitter of this
      // event is `Instance.dispose()` (triggered by `disposeProjectInstance`
      // when the user closes a project). Re-bootstrapping would send SDK
      // requests through `InstanceMiddleware` → cache miss →
      // `InstanceBootstrap` → `startGraphIndexing` → `indexProjectAsync`,
      // which clears the tombstone set by `delete_project_index` and kicks
      // off a full background index — exactly what "clear index" is meant
      // to prevent. When the user re-opens the project later, the normal
      // open-project path bootstraps it fresh.
      return
    }
    case "session.created": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit: input.store.limit, permission: input.store.permission })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      cleanupDroppedSessionCaches(input.store, input.setStore, trimmed, input.setSessionTodo)
      break
    }
    case "session.updated": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (info.time.archived) {
        if (result.found) {
          input.setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        cleanupSessionCaches(input.setStore, info.id, input.setSessionTodo)
        if (info.parentID) break
        break
      }
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit: input.store.limit, permission: input.store.permission })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      cleanupDroppedSessionCaches(input.store, input.setStore, trimmed, input.setSessionTodo)
      break
    }
    case "session.deleted": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
      }
      cleanupSessionCaches(input.setStore, info.id, input.setSessionTodo)
      if (info.parentID) break
      break
    }
    case "session.diff": {
      const props = event.properties as { sessionID: string; diff: SnapshotFileDiff[] }
      input.setStore("session_diff", props.sessionID, reconcile(list(props.diff), { key: "file" }))
      break
    }
    case "todo.updated": {
      const props = event.properties as { sessionID: string; todos: Todo[] }
      input.setStore("todo", props.sessionID, reconcile(props.todos, { key: "id" }))
      input.setSessionTodo?.(props.sessionID, props.todos)
      break
    }
    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      input.setStore("session_status", props.sessionID, reconcile(props.status))
      break
    }
    case "message.updated": {
      const info = clean((event.properties as { info: Message }).info)
      // Abort-marker backstop: the optimistic per-message marker applied when
      // Stop is pressed (prompt-input submit.ts) can land before the assistant
      // message itself exists in the store — delegated (Rust run-loop) turns
      // surface their assistant row only after a poll cycle — in which case
      // the marker finds no target and the interrupted divider never renders
      // (flaky prompt-stop e2e). While the session is in its post-stop aborted
      // window (cleared by the next send), any assistant message arriving
      // without an error carries the marker instead. Server-persisted abort
      // markers (Rust MessageAbortedError rows) always win via the !info.error
      // guard.
      if (
        info.role === "assistant" &&
        !info.error &&
        input.isAborted?.(info.sessionID)
      ) {
        info.error = { name: "MessageAbortedError", data: { message: "Interrupted by user" } }
      }
      const messages = input.store.message?.[info.sessionID]
      if (!messages) {
        input.setStore("message", info.sessionID, [info])
        break
      }
      const result = Binary.search(messages, info.id, (m) => m.id)
      if (result.found) {
        input.setStore("message", info.sessionID, result.index, reconcile(info))
        break
      }
      input.setStore(
        "message",
        info.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, info)
        }),
      )
      break
    }
    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      input.setStore(
        produce((draft) => {
          const messages = draft.message[props.sessionID]
          if (messages) {
            const result = Binary.search(messages, props.messageID, (m) => m.id)
            if (result.found) messages.splice(result.index, 1)
          }
          delete draft.part[props.messageID]
        }),
      )
      break
    }
    case "message.part.updated": {
      const part = (event.properties as { part: Part }).part
      if (SKIP_PARTS.has(part.type)) break
      // Filter LLM output content for aborted sessions (user clicked stop)
      if ((part.type === "text" || part.type === "reasoning") && input.isAborted?.(part.sessionID)) break
      // Preserve TS-side ctx.metadata() values (e.g. task sub-session id) that the
      // Rust completed/error state would otherwise wipe via reconcile (metadata: {}).
      if (part.type === "tool") {
        const existing = input.store.part[part.messageID]?.find((p) => p.id === part.id)
        preserveToolMetadata(existing, part)
      }
      const parts = input.store.part[part.messageID]
      if (!parts) {
        input.setStore("part", part.messageID, [part])
        break
      }
      const result = Binary.search(parts, part.id, (p) => p.id)
      if (result.found) {
        input.setStore("part", part.messageID, result.index, reconcile(part))
        break
      }
      input.setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(result.index, 0, part)
        }),
      )
      break
    }
    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      const parts = input.store.part[props.messageID]
      if (!parts) break
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (result.found) {
        input.setStore(
          produce((draft) => {
            const list = draft.part[props.messageID]
            if (!list) return
            const next = Binary.search(list, props.partID, (p) => p.id)
            if (!next.found) return
            list.splice(next.index, 1)
            if (list.length === 0) delete draft.part[props.messageID]
          }),
        )
      }
      break
    }
    case "message.part.delta": {
      const props = event.properties as { messageID: string; partID: string; field: string; delta: string }
      const parts = input.store.part[props.messageID]
      if (!parts) break
      // Filter LLM output deltas for aborted sessions
      const sessionID = parts.find((p) => p.id === props.partID)?.sessionID
      if (sessionID && input.isAborted?.(sessionID)) break
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (!result.found) break
	      input.setStore(
	        "part",
	        props.messageID,
	        produce((draft) => {
	          const part = draft[result.index]!
	          // Skip delta if the part already has a completed time (time.end).
	          // This prevents late-arriving SSE deltas from appending to a part
	          // that has already been finalised via reconcile from a DB poll.
	          // Placeholder parts (created by ensurePlaceholder in prompt.ts
	          // for streaming SSE text/reasoning deltas) have no time.end, so
	          // normal delta accumulation is unaffected.
	          if ((part as any).time?.end) return
          const field = props.field as keyof typeof part
          const existing = part[field] as string | undefined
          // field 是字符串类型属性的键；part 为 immer draft，此处仅对字符串字段追加 delta。
          // 用 Record 断言规避 "keyof 联合类型不可直接赋 string" 的限制（运行时行为不变）。
          ;(part as Record<keyof typeof part, string | undefined>)[field] = (existing ?? "") + props.delta
	        }),
	      )
      break
    }
    case "vcs.branch.updated": {
      const props = event.properties as { branch?: string }
      if (input.store.vcs?.branch === props.branch) break
      const next = { ...input.store.vcs, branch: props.branch }
      input.setStore("vcs", next)
      if (input.vcsCache) input.vcsCache.setStore("value", next)
      break
    }
    case "permission.asked": {
      const permission = event.properties as PermissionRequest
      const permissions = input.store.permission[permission.sessionID]
      if (!permissions) {
        input.setStore("permission", permission.sessionID, [permission])
        break
      }
      const result = Binary.search(permissions, permission.id, (p) => p.id)
      if (result.found) {
        input.setStore("permission", permission.sessionID, result.index, reconcile(permission))
        break
      }
      input.setStore(
        "permission",
        permission.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, permission)
        }),
      )
      break
    }
    case "permission.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      const permissions = input.store.permission[props.sessionID]
      if (!permissions) break
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (!result.found) break
      input.setStore(
        "permission",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "question.asked": {
      const question = event.properties as QuestionRequest
      const questions = input.store.question[question.sessionID]
      if (!questions) {
        input.setStore("question", question.sessionID, [question])
        break
      }
      const result = Binary.search(questions, question.id, (q) => q.id)
      if (result.found) {
        input.setStore("question", question.sessionID, result.index, reconcile(question))
        break
      }
      input.setStore(
        "question",
        question.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, question)
        }),
      )
      break
    }
    case "question.replied":
    case "question.rejected": {
      const props = event.properties as { sessionID: string; requestID: string }
      const questions = input.store.question[props.sessionID]
      if (!questions) break
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (!result.found) break
      input.setStore(
        "question",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "lsp.updated": {
      input.loadLsp()
      break
    }
    case "mcp.tools.changed": {
      input.refreshMcp()
      break
    }
    case "graph.index-status": {
      const props = event.properties as { status: GraphIndexInfo }
      input.setStore("graph_index_status", reconcile(props.status))
      break
    }
  }
}
