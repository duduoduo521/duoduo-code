import { For, createEffect, createMemo, on, onCleanup, Show, Index, type JSX, createSignal, untrack } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@duoduo-ai/ui/button"
import { FileIcon } from "@duoduo-ai/ui/file-icon"
import { Icon } from "@duoduo-ai/ui/icon"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { DropdownMenu } from "@duoduo-ai/ui/dropdown-menu"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { DialogConfirm } from "@/components/dialog-confirm"
import { InlineInput } from "@duoduo-ai/ui/inline-input"
import { Spinner } from "@duoduo-ai/ui/spinner"
import { SessionTurn } from "@duoduo-ai/ui/session-turn"
import { ScrollView } from "@duoduo-ai/ui/scroll-view"
import type { AssistantMessage, Message as MessageType, Part, TextPart, UserMessage } from "@duoduo-ai/sdk/v2"
import { showToast } from "@duoduo-ai/ui/toast"
import { Tooltip, TooltipKeybind } from "@duoduo-ai/ui/tooltip"
import { Binary } from "@duoduo-ai/shared/util/binary"
import { getFilename } from "@duoduo-ai/shared/util/path"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useSessionKey } from "@/pages/session/session-layout"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useGlobalSync } from "@/context/global-sync"
import { useLocal } from "@/context/local"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import { errorMessage } from "@/context/file/error-message"
import { makeTimer } from "@solid-primitives/timer"

type MessageComment = {
  path: string
  comment: string
  selection?: {
    startLine: number
    endLine: number
  }
}

const emptyMessages: MessageType[] = []
const idle = { type: "idle" as const }
type UserActions = {
  fork?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  revert?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  /**
   * Declares that this turn is about to be replaced by an identical re-send
   * (retry button / edit-and-resend). The timeline keeps the old turn mounted
   * until the replacement arrives — without this the list empties for a frame
   * or two, the scroll viewport collapses and the view snaps back to the top.
   */
  markResend?: (input: { messageID: string }) => void
}

const messageComments = (parts: Part[]): MessageComment[] =>
  parts.flatMap((part) => {
    if (part.type !== "text" || !(part).synthetic) return []
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return []
    return [
      {
        path: next.path,
        comment: next.comment,
        selection: next.selection
          ? {
              startLine: next.selection.startLine,
              endLine: next.selection.endLine,
            }
          : undefined,
      },
    ]
  })

const taskDescription = (part: Part, sessionID: string) => {
  if (part.type !== "tool" || part.tool !== "task") return
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (metadata?.sessionId !== sessionID) return
  const value = part.state.input?.description
  if (typeof value === "string" && value) return value
}

const pace = (width: number) => Math.round(Math.max(1200, Math.min(3200, (Math.max(width, 360) * 2000) / 900)))

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

type StageConfig = {
  init: number
  batch: number
}

type TimelineStageInput = {
  sessionKey: () => string
  turnStart: () => number
  messages: () => UserMessage[]
  config: StageConfig
}

/**
 * Defer-mounts small timeline windows so revealing older turns does not
 * block first paint with a large DOM mount.
 *
 * Once staging completes for a session it never re-stages — backfill and
 * new messages render immediately.
 */
function createTimelineStaging(input: TimelineStageInput) {
  const [state, setState] = createStore({
    activeSession: "",
    completedSession: "",
    count: 0,
  })

  const stagedCount = createMemo(() => {
    const total = input.messages().length
    if (input.turnStart() <= 0) return total
    if (state.completedSession === input.sessionKey()) return total
    const init = Math.min(total, input.config.init)
    if (state.count <= init) return init
    if (state.count >= total) return total
    return state.count
  })

  const stagedUserMessages = createMemo(() => {
    const list = input.messages()
    const count = stagedCount()
    if (count >= list.length) return list
    return list.slice(Math.max(0, list.length - count))
  })

  let frame: number | undefined
  const cancel = () => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }

  createEffect(
    on(
      () => [input.sessionKey(), input.turnStart() > 0, input.messages().length] as const,
      ([sessionKey, isWindowed, total]) => {
        cancel()
        const shouldStage =
          isWindowed &&
          total > input.config.init &&
          state.completedSession !== sessionKey &&
          state.activeSession !== sessionKey
        if (!shouldStage) {
          setState({ activeSession: "", count: total })
          return
        }

        let count = Math.min(total, Math.max(state.count, input.config.init))
        setState({ activeSession: sessionKey, count })

        const step = () => {
          if (input.sessionKey() !== sessionKey) {
            frame = undefined
            return
          }
          const currentTotal = input.messages().length
          count = Math.min(currentTotal, count + input.config.batch)
          setState("count", count)
          if (count >= currentTotal) {
            setState({ completedSession: sessionKey, activeSession: "" })
            frame = undefined
            return
          }
          frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
      },
    ),
  )

  const isStaging = createMemo(() => {
    const key = input.sessionKey()
    return state.activeSession === key && state.completedSession !== key
  })

  onCleanup(cancel)
  return { messages: stagedUserMessages, isStaging }
}

export function MessageTimeline(props: {
  mobileChanges: boolean
  mobileFallback: JSX.Element
  actions?: UserActions
  scroll: { overflow: boolean; bottom: boolean; jump: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onTurnBackfillScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  turnStart: number
  historyMore: boolean
  historyLoading: boolean
  onLoadEarlier: () => void
  renderedUserMessages: UserMessage[]
  anchor: (id: string) => string
}) {
  let touchGesture: number | undefined

  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const settings = useSettings()
  const dialog = useDialog()
  const language = useLanguage()
  const command = useCommand()
  const local = useLocal()
  const { params, sessionKey } = useSessionKey()

  const rendered = createMemo(() => props.renderedUserMessages.map((message) => message.id))
  const sessionID = createMemo(() => params.id)
  const sessionMessages = createMemo(() => {
    const id = sessionID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })

  // Index: parent messageID -> child assistant messageIDs. Built once per
  // sessionMessages change (O(N)) so windowing lookups are O(1) per turn
  // instead of O(window * total) nested scans on every scroll/delta.
  const parentChildrenIndex = createMemo(() => {
    const idx = new Map<string, string[]>()
    for (const msg of sessionMessages()) {
      if (msg.role === "assistant" && msg.parentID) {
        const arr = idx.get(msg.parentID)
        if (arr) arr.push(msg.id)
        else idx.set(msg.parentID, [msg.id])
      }
    }
    return idx
  })

  // Window-scoped messages: only the rendered user messages and their direct
  // assistant children. Passed to <SessionTurn messages=...> so each turn
  // subscribes to the window subset, not the entire session array — this
  // prevents every streaming delta from recomputing all turns (scroll lag
  // root cause) and keeps allMessages stable within the window.
  const windowMessages = createMemo(() => {
    const all = sessionMessages()
    const idx = parentChildrenIndex()
    const keep = new Set<string>()
    for (const userMsg of props.renderedUserMessages) {
      keep.add(userMsg.id)
      const children = idx.get(userMsg.id)
      if (children) for (const cid of children) keep.add(cid)
    }
    if (keep.size === all.length) return all
    return all.filter((m) => keep.has(m.id))
  })

  // Parts windowing: keep parts only for messages inside the render window.
  // Releases parts outside the window to bound memory usage regardless of
  // total conversation length. Loads missing parts on demand (localhost, fast).
  createEffect(
    on(
      () => props.renderedUserMessages,
      (userMsgs) => {
        const sid = sessionID()
        if (!sid) return

        // Use the LIVE session messages, not the captured `userMsgs` snapshot.
        // Reverted/deleted messages are already gone from sessionMessages(), so
        // they are naturally excluded here — we never load parts for a message
        // the sidecar has physically removed (NotFoundError root cause).
        const all = untrack(() => sessionMessages())
        const idx = untrack(() => parentChildrenIndex())
        const windowIds = new Set<string>()

        for (const userMsg of userMsgs) {
          // Guard: the sidecar may have removed this user message before the
          // SSE `Removed` event reached the store (e.g. inline edit + resend).
          if (!all.some((m) => m.id === userMsg.id)) continue
          windowIds.add(userMsg.id)
          const children = idx.get(userMsg.id)
          if (children) for (const cid of children) windowIds.add(cid)
        }

        // Release parts outside the window. NOTE: `store.part` is a
        // directory-wide dict keyed by messageID and is SHARED by every
        // session. We must only drop parts that belong to the current
        // session (parts[].sessionID); releasing without this guard deleted
        // the parent session's parts when the user navigated into a
        // sub-session (whose windowIds only cover the sub-session's messages).
        sync.set(
          "part",
          produce((draft) => {
            for (const id of Object.keys(draft)) {
              if (windowIds.has(id)) continue
              const parts = draft[id]
              if (!parts || parts.length === 0) continue
              if (parts[0]?.sessionID === sid) delete draft[id]
            }
          }),
        )

        // Load missing parts inside the window. A message may have been
        // physically removed by the sidecar between our windowIds computation
        // and this load (race on revert/edit); swallow NotFoundError — there
        // is nothing to render for a message that no longer exists.
        for (const id of windowIds) {
          if (sync.data.part[id] === undefined) {
            void sync.parts.load(sid, id).catch((err) => {
              if (err && (err.code === "NOT_FOUND" || err.message?.includes("not found"))) return
              throw err
            })
          }
        }
      },
      { defer: true },
    ),
  )
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync.data.session_status[id] ?? idle
  })
  const pending = createMemo(() => {
    // Only consider a message as "pending" when the session is actively working.
    // Rust's runLoop writes intermediate assistant messages (finish=tool-calls)
    // with time.completed=None, but those are not truly pending when the
    // session is idle — they are historical tool-call messages whose
    // completed timestamp was never backfilled.
    const status = sessionStatus()
    if (status.type === "idle") return undefined
    const messages = sessionMessages()
    // A genuinely in-flight assistant message is always parented under the
    // latest user message (Rust sets parent_id = message_rows.last() at the
    // start of the loop). Restricting the search to the current turn avoids
    // matching historical tool-call messages (completed=None) that belong to
    // earlier turns — which would otherwise make `activeMessageID` resolve to
    // an older turn and render the "thinking" indicator in the wrong place
    // while the new assistant message has not yet been persisted.
    let lastUserID: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        lastUserID = messages[i]!.id
        break
      }
    }
    if (!lastUserID) return undefined
    return messages.findLast(
      (item): item is AssistantMessage =>
        item.role === "assistant" &&
        item.parentID === lastUserID &&
        typeof item.time.completed !== "number",
    )
  })
  const working = createMemo(() => sessionStatus().type !== "idle")

  // 根因修复：Rust runLoop 在 LLM 完成、把含 tokens/completed 的最终 message 写入
  // 数据库（agent.rs 写库处）后，并未通过 message.updated 事件把 tokens/completed 推送
  // 给前端（LoopStreamEvent 枚举无 LoopMessageUpdated）。前端 store 里的 assistant
  // message 停留在流式创建时的 tokens=None / completed=None，导致底部 meta 不显示
  // 耗时与 token。GET messages（TS 编排层）返回的是 DB 最终版（含 tokens），因此这里
  // 在会话从 working→idle 时强制重新拉取 messages，用最终版回填 store，使耗时/token 显示。
  let wasWorking = false
  createEffect(
    on(working, (isWorking) => {
      const prev = wasWorking
      wasWorking = isWorking
      if (prev && !isWorking) {
        const id = sessionID()
        if (id) void sync.session.sync(id, { force: true })
      }
    }),
  )

  const tint = createMemo(() => messageAgentColor(sessionMessages(), sync.data.agent))

  const [timeoutDone, setTimeoutDone] = createSignal(true)

  const workingStatus = createMemo<"hidden" | "showing" | "hiding">((prev) => {
    if (working()) return "showing"
    if (prev === "showing" || !timeoutDone()) return "hiding"
    return "hidden"
  })

  createEffect(() => {
    if (workingStatus() !== "hiding") return

    setTimeoutDone(false)
    makeTimer(() => setTimeoutDone(true), 260, setTimeout)
  })

  const activeMessageID = createMemo(() => {
    const parentID = pending()?.parentID
    if (parentID) {
      const messages = sessionMessages()
      const result = Binary.search(messages, parentID, (message) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message && message.role === "user") return message.id
    }

    const status = sessionStatus()
    if (status.type !== "idle") {
      const messages = sessionMessages()
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === "user") return messages[i]!.id
      }
    }

    return undefined
  })
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync.session.get(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const titleLabel = createMemo(() => sessionTitle(titleValue()))
  const parentID = createMemo(() => info()?.parentID)
  const parent = createMemo(() => {
    const id = parentID()
    if (!id) return
    return sync.session.get(id)
  })
  const parentMessages = createMemo(() => {
    const id = parentID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })
  const parentTitle = createMemo(() => sessionTitle(parent()?.title) ?? language.t("command.session.new"))
  const childTaskDescription = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return parentMessages()
      .flatMap((message) => sync.data.part[message.id] ?? [])
      .map((part) => taskDescription(part, id))
      .findLast((value): value is string => !!value)
  })
  const childTitle = createMemo(() => {
    if (!parentID()) return titleLabel() ?? ""
    if (childTaskDescription()) return childTaskDescription()
    const value = titleLabel()?.replace(/\s+\(@[^)]+ subagent\)$/, "")
    if (value) return value
    return language.t("command.session.new")
  })
  const showHeader = createMemo(() => !!(titleValue() || parentID()))
  const stageCfg = { init: 1, batch: 3 }
  const staging = createTimelineStaging({
    sessionKey,
    turnStart: () => props.turnStart,
    messages: () => props.renderedUserMessages,
    config: stageCfg,
  })

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
    pendingRename: false,
  })
  let titleRef: HTMLInputElement | undefined

  const [bar, setBar] = createStore({
    ms: pace(640),
  })

  let head: HTMLDivElement | undefined

  createResizeObserver(
    () => head,
    () => {
      if (!head || head.clientWidth <= 0) return
      setBar("ms", pace(head.clientWidth))
    },
  )

  // Re-send the original user message (text + file attachments) from scratch.
  // Reverts to the user message first so the re-sent prompt is not appended
  // after an already-completed (or failed) assistant response, then replays
  // the user's actual input. Used by both the in-message retry button and the
  // error-card retry button.
  const handleRetryUserMessage = (userMessageID: string) => {
    const sid = sessionID()
    if (!sid) return
    const messages = sync.data.message[sid] ?? []
    const userMsg = messages.find((m) => m.id === userMessageID && m.role === "user")
    if (!userMsg) return
    void (async () => {
      // Clear any pending abort marker so the re-sent run's LLM output
      // (text/reasoning) is not filtered by event-reducer — mirrors
      // setBusy in prompt-input/submit.ts. Without this, a session that
      // was ever stopped would never display retried output.
      globalSync.clearAborted(sid)
      // Keep this turn mounted until the re-sent replacement lands (see
      // `markResend` in UserActions).
      props.actions?.markResend?.({ messageID: userMessageID })
      // Optimistic busy so the spinner appears immediately, matching the
      // input-box send path (sendFollowupDraft sets session_status=busy).
      sync.set("session_status", sid, { type: "busy" })
      try {
        await sdk.client.session.revert({ sessionID: sid, messageID: userMessageID })
      } catch (err) {
        sync.set("session_status", sid, { type: "idle" })
        showToast({
          variant: "error",
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return
      }
      const originalParts = (sync.data.part[userMessageID] ?? [])
        .filter((p) => p.type === "text" || p.type === "file")
        .map((p) => {
          if (p.type === "text") return { type: "text" as const, text: p.text ?? "" } as const
          const file = p as { type: "file"; mime: string; url: string; filename?: string }
          return { type: "file" as const, mime: file.mime, url: file.url, filename: file.filename } as const
        })
      // promptAsync returns 204 (accepted); the actual LLM failure (if any)
      // surfaces as an assistant error card from the server. Only transport /
      // 409 failures reject here — surface them instead of swallowing.
      const currentModel = local.model.current()
      await sdk.client.session
        .promptAsync({
          sessionID: sid,
          parts: originalParts,
          locale: language.locale(),
          model: currentModel ? { providerID: currentModel.provider.id, modelID: currentModel.id } : undefined,
        })
        .catch((err) => {
          sync.set("session_status", sid, { type: "idle" })
          showToast({
            variant: "error",
            title: language.t("prompt.toast.promptSendFailed.title"),
            description: errorMessage(err, language.t("common.requestFailed")),
          })
        })
      // Re-anchor to the bottom. `revert` above deleted the user message and the
      // failed turn; promptAsync re-creates them asynchronously. That
      // delete → recreate window collapses the scroll content, which can drop
      // the viewport below the history-backfill threshold and leave it stranded
      // at the top once auto-follow stops. Same anchoring the "jump to latest"
      // button uses.
      props.onResumeScroll()
    })()
  }

  // Edit the last user message and re-send it from scratch.
  // Identical path to handleRetryUserMessage (revert + promptAsync) but with the
  // edited text replacing the original — this is what the double-click edit in
  // SessionTurn triggers. SessionTurn only calls onEdit for the last user message,
  // so `revert` never reverts disk files (zero risk, same as the retry button).
  const handleEditUserMessage = (userMessageID: string, newText: string) => {
    const sid = sessionID()
    if (!sid) return
    const messages = sync.data.message[sid] ?? []
    const userMsg = messages.find((m) => m.id === userMessageID && m.role === "user")
    if (!userMsg) return
    void (async () => {
      // Clear any pending abort marker so the re-sent run's LLM output
      // (text/reasoning) is not filtered by event-reducer — mirrors
      // setBusy in prompt-input/submit.ts.
      globalSync.clearAborted(sid)
      // Keep this turn mounted until the edited replacement lands (see
      // `markResend` in UserActions).
      props.actions?.markResend?.({ messageID: userMessageID })
      // Optimistic busy so the spinner appears immediately, matching the
      // input-box send path (sendFollowupDraft sets session_status=busy).
      sync.set("session_status", sid, { type: "busy" })
      try {
        await sdk.client.session.revert({ sessionID: sid, messageID: userMessageID })
      } catch (err) {
        sync.set("session_status", sid, { type: "idle" })
        showToast({
          variant: "error",
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return
      }
      // promptAsync returns 204 (accepted); the actual LLM failure (if any)
      // surfaces as an assistant error card from the server. Only transport /
      // 409 failures reject here — surface them instead of swallowing.
      const currentModel = local.model.current()
      await sdk.client.session
        .promptAsync({
          sessionID: sid,
          parts: [{ type: "text", text: newText }],
          locale: language.locale(),
          model: currentModel ? { providerID: currentModel.provider.id, modelID: currentModel.id } : undefined,
        })
        .catch((err) => {
          sync.set("session_status", sid, { type: "idle" })
          showToast({
            variant: "error",
            title: language.t("prompt.toast.promptSendFailed.title"),
            description: errorMessage(err, language.t("common.requestFailed")),
          })
        })
      // Same delete → recreate window as handleRetryUserMessage; re-anchor so
      // the regenerated turn stays in view.
      props.onResumeScroll()
    })()
  }

  const titleMutation = useMutation(() => ({
    mutationFn: (input: { id: string; title: string }) =>
      sdk.client.session.update({ sessionID: input.id, title: input.title }),
    onSuccess: (_, input) => {
      sync.set(
        produce((draft) => {
          const index = draft.session.findIndex((s) => s.id === input.id)
          if (index !== -1) draft.session[index]!.title = input.title
        }),
      )
      setTitle("editing", false)
    },
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: errorMessage(err, language.t("common.requestFailed")),
      })
    },
  }))

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
        }),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [parentID(), childTaskDescription()] as const,
      ([id, description]) => {
        if (!id || description) return
        if (sync.data.message[id] !== undefined) return
        void sync.session.sync(id)
      },
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID() || parentID()) return
    setTitle({ editing: true, draft: titleLabel() ?? "" })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle("editing", false)
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const next = title.draft.trim()
    if (!next || next === (titleLabel() ?? "")) {
      setTitle("editing", false)
      return
    }

    titleMutation.mutate({ id, title: next })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string, nextSessionID?: string) => {
    if (params.id !== sessionID) return
    if (parentID) {
      navigate(`/${params.dir}/session/${parentID}`)
      return
    }
    if (nextSessionID) {
      navigate(`/${params.dir}/session/${nextSessionID}`)
      return
    }
    navigate(`/${params.dir}/session`)
  }

  const archiveSession = async (sessionID: string) => {
    const session = sync.session.get(sessionID)
    if (!session) return

    const sessions = sync.data.session ?? []
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    await sdk.client.session
      .update({ sessionID, time: { archived: Date.now() } })
      .then(() => {
        sync.set(
          produce((draft) => {
            const index = draft.session.findIndex((s) => s.id === sessionID)
            if (index !== -1) draft.session.splice(index, 1)
          }),
        )
        navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
      })
      .catch((err) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
      })
  }

  const deleteSession = async (sessionID: string) => {
    const session = sync.session.get(sessionID)
    if (!session) return false

    const sessions = (sync.data.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk.client.session
      .delete({ sessionID })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          variant: "error",
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    if (!result) return false

    sync.set(
      produce((draft) => {
        const removed = new Set<string>([sessionID])

        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }

        const stack = [sessionID]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue

          const children = byParent.get(parentID)
          if (!children) continue

          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }

        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
    return true
  }

  const navigateParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${params.dir}/session/${id}`)
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const name = createMemo(
      () => sessionTitle(sync.session.get(props.sessionID)?.title) ?? language.t("command.session.new"),
    )
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    return (
      <DialogConfirm
        title={language.t("session.delete.title")}
        danger
        confirmLabel={language.t("session.delete.button")}
        message={language.t("session.delete.confirm", { name: name() })}
        onConfirm={handleDelete}
        onCancel={() => dialog.close()}
      />
    )
  }

  return (
    <Show
      when={!props.mobileChanges}
      fallback={<div class="relative h-full overflow-hidden">{props.mobileFallback}</div>}
    >
      <div class="relative w-full h-full min-w-0">
        <div
          class="absolute left-1/2 -translate-x-1/2 bottom-6 z-[60] pointer-events-none transition-all duration-200 ease-out"
          classList={{
            "opacity-100 translate-y-0 scale-100": props.scroll.overflow && props.scroll.jump && !staging.isStaging(),
            "opacity-0 translate-y-2 scale-95 pointer-events-none":
              !props.scroll.overflow || !props.scroll.jump || staging.isStaging(),
          }}
        >
          <button
            class="pointer-events-auto flex items-center justify-center w-10 h-8 bg-transparent border-none cursor-pointer p-0 group"
            onClick={props.onResumeScroll}
          >
            <div
              class="flex items-center justify-center w-8 h-6 rounded-[6px] border border-border-weaker-base bg-surface-raised-stronger-non-alpha backdrop-blur-[0.75px] transition-colors group-hover:border-[var(--border-weak-base)] group-hover:[--icon-base:var(--icon-hover)]"
              style={{
                "box-shadow": "var(--shadow-lg)",
              }}
            >
              <Icon name="arrow-down-to-line" size="small" />
            </div>
          </button>
        </div>
        <ScrollView
          viewportRef={props.setScrollRef}
          onWheel={(e) => {
            const root = e.currentTarget
            const delta = normalizeWheelDelta({
              deltaY: e.deltaY,
              deltaMode: e.deltaMode,
              rootHeight: root.clientHeight,
            })
            if (!delta) return
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchStart={(e) => {
            touchGesture = e.touches[0]?.clientY
          }}
          onTouchMove={(e) => {
            const next = e.touches[0]?.clientY
            const prev = touchGesture
            touchGesture = next
            if (next === undefined || prev === undefined) return

            const delta = prev - next
            if (!delta) return

            const root = e.currentTarget
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchEnd={() => {
            touchGesture = undefined
          }}
          onTouchCancel={() => {
            touchGesture = undefined
          }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onScroll={(e) => {
            props.onScheduleScrollState(e.currentTarget)
            props.onTurnBackfillScroll()
            // 始终执行：autoScroll.handleScroll 内部用 isAuto() 区分程序化滚动，
            // 不会误置 userScrolled。去掉手势门控，使拖滚动条/方向键上滚也能正确暂停跟随。
            props.onAutoScrollHandleScroll()
            if (!props.hasScrollGesture()) return
            props.onUserScroll()
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onClick={props.onAutoScrollInteraction}
          class="relative min-w-0 w-full h-full"
          classList={{
            "session-chat-watermark": props.renderedUserMessages.length > 0,
          }}
          style={{
            "--session-title-height": showHeader() ? "40px" : "0px",
            "--sticky-accordion-top": showHeader() ? "48px" : "0px",
          }}
        >
          <div ref={props.setContentRef} class="min-w-0 w-full">
            <Show when={showHeader()}>
              <div
                ref={(el) => {
                  head = el
                  setBar("ms", pace(el.clientWidth))
                }}
                data-session-title
                classList={{
                  "sticky top-0 z-30 bg-[linear-gradient(to_bottom,var(--background-stronger)_48px,transparent)]": true,
                  relative: true,
                  "w-full": true,
                  "pb-4": true,
                  "pl-2 pr-3 md:pl-4 md:pr-3": true,
                  "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
                }}
              >
                <div class="h-12 w-full flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1 min-w-0 flex-1 pr-3">
                    <div class="flex items-center min-w-0 grow-1">
                      <Show when={parentID()}>
                        <button
                          type="button"
                          data-slot="session-title-parent"
                          class="min-w-0 max-w-[40%] truncate text-14-medium text-text-weak transition-colors hover:text-text-base"
                          onClick={navigateParent}
                        >
                          {parentTitle()}
                        </button>
                        <span
                          data-slot="session-title-separator"
                          class="px-2 text-14-medium text-text-weak"
                          aria-hidden="true"
                        >
                          /
                        </span>
                      </Show>
                      <div
                        class="shrink-0 flex items-center justify-center overflow-hidden transition-[width,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                        style={{
                          width: working() ? "16px" : "0px",
                          "margin-right": working() ? "8px" : "0px",
                        }}
                        aria-hidden="true"
                      >
                        <Show when={workingStatus() !== "hidden"}>
                          <div
                            class="transition-opacity duration-200 ease-out"
                            classList={{ "opacity-0": workingStatus() === "hiding" }}
                          >
                            <Spinner class="size-4" style={{ color: tint() ?? "var(--icon-interactive-base)" }} />
                          </div>
                        </Show>
                      </div>
                      <Show when={childTitle() || title.editing}>
                        <Show
                          when={title.editing}
                          fallback={
                            <h1
                              data-slot="session-title-child"
                              class="text-14-medium text-text-strong truncate grow-1 min-w-0"
                              onDblClick={openTitleEditor}
                            >
                              {childTitle()}
                            </h1>
                          }
                        >
                          <InlineInput
                            ref={(el) => {
                              titleRef = el
                            }}
                            data-slot="session-title-child"
                            value={title.draft}
                            disabled={titleMutation.isPending}
                            class="text-14-medium text-text-strong grow-1 min-w-0 rounded-[6px] pl-1 -ml-1"
                            style={{ "--inline-input-shadow": "var(--shadow-xs-border-select)" }}
                            onInput={(event) => setTitle("draft", event.currentTarget.value)}
                            onKeyDown={(event) => {
                              event.stopPropagation()
                              if (event.key === "Enter") {
                                event.preventDefault()
                                 saveTitleEditor()
                                return
                              }
                              if (event.key === "Escape") {
                                event.preventDefault()
                                closeTitleEditor()
                              }
                            }}
                            onBlur={closeTitleEditor}
                          />
                        </Show>
                      </Show>
                    </div>
                  </div>
                  <Show when={sessionID()} keyed>
                    {(id) => (
                      <div class="shrink-0 flex items-center gap-3">
                        <SessionContextUsage placement="bottom" />
                        <Show when={!parentID()}>
                          <TooltipKeybind
                            placement="bottom"
                            title={language.t("command.session.new")}
                            keybind={command.keybind("session.new")}
                            openDelay={2000}
                          >
                            <IconButton
                              icon="new-session"
                              variant="ghost"
                              class="size-6 rounded-md"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (!params.dir) return
                                navigate(`/${params.dir}/session`)
                              }}
                              aria-label={language.t("command.session.new")}
                            />
                          </TooltipKeybind>
                          <DropdownMenu
                            gutter={4}
                            placement="bottom-end"
                            open={title.menuOpen}
                            onOpenChange={(open) => {
                              setTitle("menuOpen", open)
                              if (open) return
                            }}
                          >
                            <DropdownMenu.Trigger
                              as={IconButton}
                              icon="dot-grid"
                              variant="ghost"
                              class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                              aria-label={language.t("common.moreOptions")}
                              aria-expanded={title.menuOpen}
                            />
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content
                                style={{ "min-width": "104px" }}
                                onCloseAutoFocus={(event) => {
                                  if (title.pendingRename) {
                                    event.preventDefault()
                                    setTitle("pendingRename", false)
                                    openTitleEditor()
                                    return
                                  }
                                }}
                              >
                                <DropdownMenu.Item
                                  onSelect={() => {
                                    setTitle("pendingRename", true)
                                    setTitle("menuOpen", false)
                                  }}
                                >
                                  <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item onSelect={() => void archiveSession(id)}>
                                  <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Separator />
                                <DropdownMenu.Item
                                  onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id} />)}
                                >
                                  <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                              </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                          </DropdownMenu>


                        </Show>
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </Show>
            <div
              role="log"
              data-slot="session-turn-list"
              class="flex flex-col items-start justify-start pb-32 transition-[margin]"
              classList={{
                "w-full": true,
                "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
                "mt-0.5": props.centered,
                "mt-0": !props.centered,
              }}
            >
              <Show when={props.turnStart > 0 || props.historyMore}>
                <div class="w-full flex justify-center">
                  <Button
                    variant="ghost"
                    size="large"
                    class="text-12-medium opacity-50"
                    disabled={props.historyLoading}
                    onClick={props.onLoadEarlier}
                  >
                    {props.historyLoading
                      ? language.t("session.messages.loadingEarlier")
                      : language.t("session.messages.loadEarlier")}
                  </Button>
                </div>
              </Show>
              <For each={rendered()}>
                {(messageID) => {
                  const active = createMemo(() => activeMessageID() === messageID)
                  const comments = createMemo(() => messageComments(sync.data.part[messageID] ?? []), [], {
                    equals: (a, b) =>
                      a.length === b.length &&
                      a.every(
                        (c, i) =>
                          c.path === b[i]!.path &&
                          c.comment === b[i]!.comment &&
                          c.selection?.startLine === b[i]!.selection?.startLine &&
                          c.selection?.endLine === b[i]!.selection?.endLine,
                      ),
                  })
                  const commentCount = createMemo(() => comments().length)
                  return (
                    <div
                      id={props.anchor(messageID)}
                      data-message-id={messageID}
                      classList={{
                        "min-w-0 w-full max-w-full": true,
                        "md:max-w-200 2xl:max-w-[1000px]": props.centered,
                      }}
                    >
                      <Show when={commentCount() > 0}>
                        <div class="w-full px-4 md:px-5 pb-2">
                          <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                            <div class="flex w-max min-w-full justify-end gap-2">
                              <Index each={comments()}>
                                {(commentAccessor: () => MessageComment) => {
                                  const comment = createMemo(() => commentAccessor())
                                  return (
                                    <Show when={comment()}>
                                      {(c) => (
                                        <div class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2">
                                          <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                                            <FileIcon
                                              node={{ path: c().path, type: "file" }}
                                              class="size-3.5 shrink-0"
                                            />
                                            <span class="truncate">{getFilename(c().path)}</span>
                                            <Show when={c().selection}>
                                              {(selection) => (
                                                <span class="shrink-0 text-text-weak">
                                                  {selection().startLine === selection().endLine
                                                    ? `:${selection().startLine}`
                                                    : `:${selection().startLine}-${selection().endLine}`}
                                                </span>
                                              )}
                                            </Show>
                                          </div>
                                          <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                                            {c().comment}
                                          </div>
                                        </div>
                                      )}
                                    </Show>
                                  )
                                }}
                              </Index>
                            </div>
                          </div>
                        </div>
                      </Show>
                      <SessionTurn
                        sessionID={sessionID() ?? ""}
                        messageID={messageID}
                        messages={windowMessages()}
                        actions={{
                          ...props.actions,
                          retry:
                            active() &&
                            sessionStatus()?.type !== undefined &&
                            sessionStatus()?.type !== "idle"
                              ? undefined
                              : ({ messageID }) => handleRetryUserMessage(messageID),
                        }}
                        active={active()}
                        status={active() ? sessionStatus() : undefined}
                        showThinking={settings.general.showThinking()}
                        shellToolDefaultOpen={settings.general.shellToolPartsExpanded()}
                        editToolDefaultOpen={settings.general.editToolPartsExpanded()}
                        onRetry={() => handleRetryUserMessage(messageID)}
                        onEdit={(text) => handleEditUserMessage(messageID, text)}
                        onHaltSubSession={(subSessionID) => {
                          sdk.client.session.abort({ sessionID: subSessionID }).catch(() => {})
                        }}
                        classes={{
                          root: "min-w-0 w-full relative",
                          content: "flex flex-col justify-between !overflow-visible",
                          container: "w-full px-4 md:px-5",
                        }}
                      />
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </ScrollView>
      </div>
    </Show>
  )
}
