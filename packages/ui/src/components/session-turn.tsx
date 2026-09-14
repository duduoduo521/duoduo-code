import {
  AssistantMessage,
  type SnapshotFileDiff,
  Message as MessageType,
  Part as PartType,
} from "@duoduo-ai/sdk/v2/client"
import type { SessionStatus } from "@duoduo-ai/sdk/v2"
import { useData } from "../context"
import { useFileComponent } from "../context/file"

import { Binary } from "@duoduo-ai/shared/util/binary"
import { getDirectory, getFilename } from "@duoduo-ai/shared/util/path"
import { createEffect, createMemo, createSignal, For, on, onCleanup, ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { AssistantParts, Message, MessageDivider, PART_MAPPING, type UserActions } from "./message-part"
import { Card } from "./card"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { DiffChanges } from "./diff-changes"
import { Icon } from "./icon"

import { SessionRetry } from "./session-retry"
import { TextReveal } from "./text-reveal"
import { createAutoScroll } from "../hooks"
import { useI18n } from "../context/i18n"
import { normalize } from "./session-diff"
import { Collapsible } from "./collapsible"
import { reasoningHeading as reasoningHeadingFromText } from "./reasoning-heading"
import { Tooltip } from "./tooltip"

// ─── Agent Progress Panel (Issue 3) ────────────────────────────────
// A fixed-height expandable area that shows real-time agent activity.
// Displays which tools/subagents are currently running, with expand/collapse.

function AgentProgressPanel(props: {
  messages: AssistantMessage[]
  working: boolean
  sessionID: string
  onHaltSubSession?: (subSessionID: string) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  const emptyParts: PartType[] = []

  // Collect currently running/pending tool parts across all assistant messages
  const runningTools = createMemo(() => {
    if (!props.working) return []
    const result: { tool: string; status: string; title?: string; messageID: string; subSessionID?: string }[] = []
    for (const message of props.messages) {
      const parts = list(data.store.part?.[message.id], emptyParts)
      for (const part of parts) {
        if (part.type !== "tool") continue
        if (hidden.has(part.tool)) continue
        // Sub-agent (task) runs already render their own dedicated card in
        // the message timeline (message-part.tsx ToolRegistry "task"), so
        // listing them here duplicated the UI ("正在执行 sub-agent" panel).
        // Cancellation remains available via the main stop button, which
        // aborts in-flight delegated tools (prompt.ts cancel → abort).
        if (part.tool === "task") continue
        if (part.state.status === "running" || part.state.status === "pending") {
          const info = getToolInfo(part, i18n)
          result.push({
            tool: part.tool,
            status: part.state.status,
            title: info.title ?? part.tool,
            messageID: message.id,
            subSessionID: part.tool === "task" ? (part.state as any)?.metadata?.sessionId : undefined,
          })
        }
      }
    }
    return result
  })

  const hasRunning = createMemo(() => runningTools().length > 0)

  // Summarize current activity in one line
  const summaryText = createMemo(() => {
    const tools = runningTools()
    if (tools.length === 0) return i18n.t("ui.sessionTurn.status.thinking")
    const first = tools[0]
    if (tools.length === 1) {
      return first!.status === "running"
        ? i18n.t("ui.agentProgress.running", { tool: first!.title ?? first!.tool })
        : i18n.t("ui.agentProgress.pending", { tool: first!.title ?? first!.tool })
    }
    return i18n.t("ui.agentProgress.multiple", { count: tools.length })
  })

  return (
    <Show when={hasRunning()}>
      <div data-component="agent-progress-panel" class="my-1">
        {/* Collapsible trigger — always visible when working */}
        <button
          type="button"
          class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md bg-surface-raised-base border border-border-weak-base text-12-regular text-text-base hover:bg-surface-base-hover transition-colors"
          onClick={() => setExpanded(!expanded())}
        >
          <span
            class="text-icon-interactive-base transition-transform duration-200"
            style={{ transform: expanded() ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            ▶
          </span>
          <span class="flex-1 text-left truncate">{summaryText()}</span>
          <span class="text-text-weak text-11-regular">{runningTools().length}</span>
        </button>

        {/* Expandable details — fixed max-height with scroll */}
        <Show when={expanded()}>
          <div
            data-scrollable
            class="mt-1 rounded-md border border-border-weak-base bg-surface-raised-base overflow-y-auto"
            style={{ "max-height": "200px" }}
          >
            <For each={runningTools()}>
              {(item) => (
                <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border-weaker-base last:border-b-0">
                  <Show
                    when={item.status === "running"}
                    fallback={<span class="text-text-weak text-10-regular">○</span>}
                  >
                    <span class="text-icon-interactive-base animate-pulse text-10-regular">●</span>
                  </Show>
                  <span class="text-12-regular text-text-strong truncate flex-1">{item.title}</span>
                  <span
                    class={`text-10-regular ${item.status === "running" ? "text-icon-interactive-base" : "text-text-weak"}`}
                  >
                    {item.status === "running"
                      ? i18n.t("ui.agentProgress.statusRunning")
                      : i18n.t("ui.agentProgress.statusPending")}
                  </span>
                  <Show
                    when={
                      item.tool === "task" && item.status === "running" && item.subSessionID && props.onHaltSubSession
                    }
                  >
                    <button
                      type="button"
                      class="ml-auto shrink-0 w-4 h-4 flex items-center justify-center rounded text-text-weak hover:text-text-strong hover:bg-surface-base-hover transition-colors"
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onHaltSubSession?.(item.subSessionID!)
                      }}
                      title="Cancel"
                    >
                      ✕
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function getToolInfo(part: Extract<PartType, { type: "tool" }>, i18n: ReturnType<typeof useI18n>): { title?: string } {
  // Minimal info extraction — full getToolInfo is in message-part.tsx
  // Here we just return the tool name as title for the progress panel.
  try {
    const toolNames: Record<string, string> = {
      grep: "Grep",
      glob: "Glob",
      list: "List",
      read: "Read",
      edit: "Edit",
      write: "Write",
      bash: "Bash",
      webfetch: "Web Fetch",
      task: "Sub-agent",
    }
    return { title: toolNames[part.tool] ?? part.tool }
  } catch {
    return { title: part.tool }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function unwrap(message: string) {
  const text = message.replace(/^Error:\s*/, "").trim()

  const parse = (value: string) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }

  const read = (value: string) => {
    const first = parse(value)
    if (typeof first !== "string") return first
    return parse(first.trim())
  }

  let json = read(text)

  if (json === undefined) {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start !== -1 && end > start) {
      json = read(text.slice(start, end + 1))
    }
  }

  if (!record(json)) return message

  const err = record(json.error) ? json.error : undefined
  if (err) {
    const type = typeof err.type === "string" ? err.type : undefined
    const msg = typeof err.message === "string" ? err.message : undefined
    if (type && msg) return `${type}: ${msg}`
    if (msg) return msg
    if (type) return type
    const code = typeof err.code === "string" ? err.code : undefined
    if (code) return code
  }

  const msg = typeof json.message === "string" ? json.message : undefined
  if (msg) return msg

  const reason = typeof json.error === "string" ? json.error : undefined
  if (reason) return reason

  return message
}

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

const hidden = new Set(["todowrite"])

function partState(part: PartType, showReasoning: boolean) {
  if (part.type === "tool") {
    if (hidden.has(part.tool)) return
    if (part.tool === "question" && (part.state.status === "pending" || part.state.status === "running")) return
    return "visible" as const
  }
  if (part.type === "text") return part.text?.trim() ? ("visible" as const) : undefined
  if (part.type === "reasoning") {
    // A reasoning part is rendered when EITHER the "reasoning summaries"
    // toggle or the "show thinking" toggle is on AND the part has text.
    // The caller passes the OR of the two flags in `showReasoning`; treating
    // this as a single signal here makes the two settings consistent with
    // each other and with `renderable` in message-part.tsx.
    if (showReasoning && part.text?.trim()) return "visible" as const
    return
  }
  if (PART_MAPPING[part.type]) return "visible" as const
  return
}

export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    messageID: string
    messages?: MessageType[]
    actions?: UserActions
    showThinking?: boolean
    shellToolDefaultOpen?: boolean
    editToolDefaultOpen?: boolean
    active?: boolean
    status?: SessionStatus
    onUserInteracted?: () => void
    /** Called when the user clicks the retry button on an error card. */
    onRetry?: () => void
    /** Called when the user finishes editing the last user message (double-click). */
    onEdit?: (newText: string) => void
    onHaltSubSession?: (subSessionID: string) => void
    classes?: {
      root?: string
      content?: string
      container?: string
    }
  }>,
) {
  const data = useData()
  const i18n = useI18n()
  const fileComponent = useFileComponent()

  const emptyMessages: MessageType[] = []
  const emptyParts: PartType[] = []
  const emptyAssistant: AssistantMessage[] = []
  const emptyDiffs: SnapshotFileDiff[] = []
  const idle = { type: "idle" as const }

  const allMessages = createMemo(() => props.messages ?? list(data.store.message?.[props.sessionID], emptyMessages))

  const messageIndex = createMemo(() => {
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, props.messageID, (m) => m.id)

    const index = result.found ? result.index : messages.findIndex((m) => m.id === props.messageID)
    if (index < 0) return -1

    const msg = messages[index]
    if (!msg || msg.role !== "user") return -1

    return index
  })

  const message = createMemo(() => {
    const index = messageIndex()
    if (index < 0) return undefined

    const messages = allMessages() ?? emptyMessages
    const msg = messages[index]
    if (!msg || msg.role !== "user") return undefined

    return msg
  })

  const pending = createMemo(() => {
    if (typeof props.active === "boolean") return
    const messages = allMessages() ?? emptyMessages
    return messages.findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    )
  })

  const pendingUser = createMemo(() => {
    const item = pending()
    if (!item?.parentID) return
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, item.parentID, (m) => m.id)
    const msg = result.found ? messages[result.index] : messages.find((m) => m.id === item.parentID)
    if (!msg || msg.role !== "user") return
    return msg
  })

  const active = createMemo(() => {
    if (typeof props.active === "boolean") return props.active
    const msg = message()
    const parent = pendingUser()
    if (!msg || !parent) return false
    return parent.id === msg.id
  })

  const parts = createMemo(() => {
    const msg = message()
    if (!msg) return emptyParts
    return list(data.store.part?.[msg.id], emptyParts)
  })

  // ── Double-click edit (last user message only, non-interactive) ──
  // Editing reuses the proven retry path: revert to this message then re-prompt
  // with the edited text. Restricting to the LAST user message means `revert`
  // collects no downstream patch parts, so no disk files are reverted — identical
  // to the existing retry button (zero risk). `!active()` gates it to the
  // non-interactive state per the requirement.
  const isLastUser = createMemo(() => {
    const msgs = allMessages() ?? emptyMessages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m && m.role === "user") return m.id === props.messageID
    }
    return false
  })
  const canEdit = createMemo(() => !active() && isLastUser())
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  let editRef: HTMLTextAreaElement | undefined
  const beginEdit = () => {
    if (!canEdit()) return
    const text = parts()
      .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
      .map((p) => (p as { text?: string }).text ?? "")
      .join("\n")
    setDraft(text)
    setEditing(true)
  }
  const submitEdit = () => {
    const t = draft().trim()
    setEditing(false)
    if (t) props.onEdit?.(t)
  }
  const cancelEdit = () => setEditing(false)
  createEffect(() => {
    if (editing() && editRef) editRef.focus()
  })

  const compaction = createMemo(() => parts().find((part) => part.type === "compaction"))

  const diffs = createMemo(() => {
    const files = message()?.summary?.diffs
    if (!files?.length) return emptyDiffs

    const seen = new Set<string>()
    return files
      .reduceRight<SnapshotFileDiff[]>((result, diff) => {
        if (seen.has(diff.file)) return result
        seen.add(diff.file)
        result.push(diff)
        return result
      }, [])
      .reverse()
  })
  const MAX_FILES = 10
  const edited = createMemo(() => diffs().length)
  const [state, setState] = createStore({
    showAll: false,
    expanded: [] as string[],
  })
  const showAll = () => state.showAll
  const expanded = () => state.expanded
  const overflow = createMemo(() => Math.max(0, edited() - MAX_FILES))
  const visible = createMemo(() => (showAll() ? diffs() : diffs().slice(0, MAX_FILES)))
  const toggleAll = () => {
    autoScroll.pause()
    setState("showAll", !showAll())
  }

  const assistantMessages = createMemo(
    () => {
      const msg = message()
      if (!msg) return emptyAssistant

      const messages = allMessages() ?? emptyMessages
      if (messageIndex() < 0) return emptyAssistant

      const result: AssistantMessage[] = []
      for (let i = 0; i < messages.length; i++) {
        const item = messages[i]
        if (!item) continue
        if (item.role === "assistant" && item.parentID === msg.id) result.push(item)
      }
      return result
    },
    emptyAssistant,
    { equals: same },
  )

  const interrupted = createMemo(() => assistantMessages().some((m) => m.error?.name === "MessageAbortedError"))
  const divider = createMemo(() => {
    if (compaction()) return i18n.t("ui.messagePart.compaction")
    if (interrupted()) return i18n.t("ui.message.interrupted")
    return ""
  })
  const error = createMemo(
    () => assistantMessages().find((m) => m.error && m.error.name !== "MessageAbortedError")?.error,
  )
  const isContextOverflow = createMemo(() => error()?.name === "ContextOverflowError")
  const showAssistantCopyPartID = createMemo(() => {
    const messages = assistantMessages()

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue

      const parts = list(data.store.part?.[message.id], emptyParts)
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (!part || part.type !== "text" || !part.text?.trim()) continue
        return part.id
      }
    }

    return undefined
  })
  const errorText = createMemo(() => {
    const msg = error()?.data?.message
    if (typeof msg === "string") return unwrap(msg)
    if (msg === undefined || msg === null) return ""
    // oxlint-disable-next-line no-base-to-string -- msg is unknown from error data, coercion is intentional
    return unwrap(String(msg))
  })

  const status = createMemo(() => {
    if (props.status !== undefined) return props.status
    if (typeof props.active === "boolean" && !props.active) return idle
    return data.store.session_status[props.sessionID] ?? idle
  })
  const working = createMemo(() => status().type !== "idle" && active())
  const assistantCopyPartID = createMemo(() => {
    if (working()) return null
    return showAssistantCopyPartID() ?? null
  })
  const turnDurationMs = createMemo(() => {
    const start = message()?.time.created
    if (typeof start !== "number") return undefined

    const end = assistantMessages().reduce<number | undefined>((max, item) => {
      const completed = item.time.completed
      if (typeof completed !== "number") return max
      if (max === undefined) return completed
      return Math.max(max, completed)
    }, undefined)

    if (typeof end !== "number") return undefined
    if (end < start) return undefined
    return end - start
  })
  const showThinkingSetting = createMemo(() => props.showThinking ?? true)
  const assistantDerived = createMemo(() => {
    let visible = 0
    let visibleExcludingReasoning = 0
    let reason: string | undefined
    for (const message of assistantMessages()) {
      for (const part of list(data.store.part?.[message.id], emptyParts)) {
        if (partState(part, showThinkingSetting()) === "visible") {
          visible++
          if (part.type !== "reasoning") visibleExcludingReasoning++
        }
        if (part.type === "reasoning" && part.text) {
          const h = reasoningHeadingFromText(part.text)
          if (h) reason = h
        }
      }
    }
    return { visible, visibleExcludingReasoning, reason }
  })
  const assistantVisible = createMemo(() => assistantDerived().visible)
  const reasoningHeading = createMemo(() => assistantDerived().reason)
  const showThinkingShimmer = createMemo(() => {
    if (!working() || !!error()) return false
    if (status().type === "retry") return false
    // Show a "thinking" loading indicator whenever the run is in progress and no
    // tool call is currently executing. This covers the pauses BETWEEN tool calls
    // (e.g. after a shell-check result, while the model generates the next step),
    // not just the very first turn. Previously this only showed when there were no
    // visible non-reasoning parts yet, so it vanished after the first tool result
    // and never reappeared during later thinking pauses — leaving the user with a
    // blank screen and no "task not finished" signal.
    // The indicator is independent of the "show thinking" toggle: it is a generic
    // progress loader, not the reasoning content itself.
    const anyToolRunning = assistantMessages().some((message) =>
      list(data.store.part?.[message.id], emptyParts).some(
        (part) =>
          part.type === "tool" && (part.state.status === "running" || part.state.status === "pending"),
      ),
    )
    return !anyToolRunning
  })

  // "响应较慢"检测：任务运行中且超过阈值 STALL_MS 仍**没有任何内容字节**返回时，
  // 提示响应较慢，而非让用户对着一直转的占位符误以为卡死。
  // 关键语义（修复点）：
  //  - 只要有**任意**内容开始流式返回（text 或 reasoning 任一），提示必须立即消失——
  //    它不是一个从开始挂到结束的横幅。这与"显示思考内容"开关无关。
  //  - 因此之前只检查 `reasoning` part 是错的：deepseek-v3 / 讯飞等模型把总结写在
  //    `text` 里、不产 reasoning 流，导致正文已在渲染但提示从头显示到尾。
  //  - 现在改为检查 text || reasoning；只有 15s 内完全无首字节（含未开思考）才出现。
  const STALL_MS = 15000
  const hasStreamedContent = createMemo(() => {
    for (const message of assistantMessages()) {
      for (const part of list(data.store.part?.[message.id], emptyParts)) {
        if ((part.type === "reasoning" || part.type === "text") && part.text?.trim()) return true
      }
    }
    return false
  })
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const [stalled, setStalled] = createSignal(false)
  createEffect(() => {
    const w = working()
    const e = !!error()
    const has = hasStreamedContent()
    if (stallTimer) {
      clearTimeout(stallTimer)
      stallTimer = undefined
    }
    // Arm the "response is slow" hint ONLY when the run is working, healthy, and
    // NO content of any kind has streamed for STALL_MS. The moment the model
    // returns its first chunk (text or reasoning) the hint clears — regardless of
    // the "show thinking" toggle. This is purely a "no first byte yet" signal.
    if (w && !e && !has) {
      stallTimer = setTimeout(() => setStalled(true), STALL_MS)
    } else {
      setStalled(false)
    }
  })
  onCleanup(() => {
    if (stallTimer) clearTimeout(stallTimer)
  })

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
    overflowAnchor: "dynamic",
  })

  return (
    <div data-component="session-turn" class={props.classes?.root}>
      <div
        ref={autoScroll.scrollRef}
        onScroll={autoScroll.handleScroll}
        data-slot="session-turn-content"
        class={props.classes?.content}
      >
        <div onClick={autoScroll.handleInteraction}>
          <Show when={message()}>
            <div
              ref={autoScroll.contentRef}
              data-message={message()!.id}
              data-slot="session-turn-message-container"
              class={props.classes?.container}
            >
              <div
                data-slot="session-turn-message-content"
                aria-live="off"
                onDblClick={canEdit() ? beginEdit : undefined}
              >
                <Show when={!editing()} fallback={
                  <div data-slot="session-turn-edit" class="my-1">
                    <textarea
                      data-slot="session-turn-edit-input"
                      ref={editRef}
                      class="w-full min-h-[80px] resize-y rounded-md border border-border-weak-base bg-surface-base p-2 text-14-regular text-text-strong outline-none focus:border-border-strong-base"
                      value={draft()}
                      onInput={(e) => setDraft(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault()
                          submitEdit()
                        } else if (e.key === "Escape") {
                          e.preventDefault()
                          cancelEdit()
                        }
                      }}
                    />
                    <div class="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        data-slot="session-turn-edit-send"
                        class="rounded-md bg-accent-base px-3 py-1 text-12-regular text-accent-contrast-base hover:bg-accent-hover-base transition-colors"
                        onClick={submitEdit}
                      >
                        {i18n.t("ui.sessionTurn.edit.send")}
                      </button>
                      <button
                        type="button"
                        data-slot="session-turn-edit-cancel"
                        class="rounded-md border border-border-weak-base px-3 py-1 text-12-regular text-text-base hover:bg-surface-base-hover transition-colors"
                        onClick={cancelEdit}
                      >
                        {i18n.t("ui.sessionTurn.edit.cancel")}
                      </button>
                      <span class="text-11-regular text-text-weakest">Enter 发送 · Shift+Enter 换行 · Esc 取消</span>
                    </div>
                  </div>
                }>
                  <Message message={message()!} parts={parts()} actions={props.actions} showThinking={showThinkingSetting()} />
                </Show>
              </div>
              <Show when={divider()}>
                <div data-slot="session-turn-compaction">
                  <MessageDivider label={divider()} />
                </div>
              </Show>
              <Show when={assistantMessages().length > 0}>
                <div data-slot="session-turn-assistant-content" aria-hidden={working()}>
                  <AssistantParts
                    messages={assistantMessages()}
                    showAssistantCopyPartID={assistantCopyPartID()}
                    turnDurationMs={turnDurationMs()}
                    working={working()}
                    showThinking={showThinkingSetting()}
                    shellToolDefaultOpen={props.shellToolDefaultOpen}
                    editToolDefaultOpen={props.editToolDefaultOpen}
                  />
                </div>
              </Show>
              <Show when={showThinkingShimmer() || stalled()}>
                <div data-slot="session-turn-thinking">
                  <Show
                    when={stalled()}
                    fallback={
                      <span class="thinking-label">
                        <Show
                          when={reasoningHeading()}
                          fallback={i18n.t("ui.sessionTurn.status.thinking")}
                        >
                          {i18n.t("ui.sessionTurn.status.thinkingWithTopic", { topic: reasoningHeading()! })}
                        </Show>
                      </span>
                    }
                  >
                    <span class="thinking-label">{i18n.t("ui.sessionTurn.status.stalled")}</span>
                  </Show>
                  <span class="thinking-spinner" aria-hidden="true" />
                </div>
              </Show>
              <AgentProgressPanel
                messages={assistantMessages()}
                working={working()}
                sessionID={props.sessionID}
                onHaltSubSession={props.onHaltSubSession}
              />
              <SessionRetry status={status()} show={active()} />
              <Show when={edited() > 0 && !working()}>
                <div
                  data-slot="session-turn-diffs"
                  data-component="session-turn-diffs-group"
                  data-show-all={showAll() || undefined}
                >
                  <div data-slot="session-turn-diffs-header">
                    <span data-slot="session-turn-diffs-label">
                      {edited()} {i18n.t("ui.sessionTurn.diffs.changed")}{" "}
                      {i18n.t(edited() === 1 ? "ui.common.file.one" : "ui.common.file.other")}
                    </span>
                    <DiffChanges changes={diffs()} />
                    <Show when={overflow() > 0}>
                      <span data-slot="session-turn-diffs-toggle" onClick={toggleAll}>
                        {showAll() ? i18n.t("ui.sessionTurn.diffs.showLess") : i18n.t("ui.sessionTurn.diffs.showAll")}
                      </span>
                    </Show>
                  </div>
                  <div data-component="session-turn-diffs-content">
                    <Accordion
                      multiple
                      style={{ "--sticky-accordion-offset": "44px" }}
                      value={expanded()}
                      onChange={(value) => setState("expanded", Array.isArray(value) ? value : value ? [value] : [])}
                    >
                      <For each={visible()}>
                        {(diff) => {
                          const view = normalize(diff)
                          const active = createMemo(() => expanded().includes(diff.file))
                          const [shown, setShown] = createSignal(false)

                          createEffect(
                            on(
                              active,
                              (value) => {
                                if (!value) {
                                  setShown(false)
                                  return
                                }

                                requestAnimationFrame(() => {
                                  if (!active()) return
                                  setShown(true)
                                })
                              },
                              { defer: true },
                            ),
                          )

                          return (
                            <Accordion.Item value={diff.file}>
                              <StickyAccordionHeader>
                                <Accordion.Trigger>
                                  <div data-slot="session-turn-diff-trigger">
                                    <span data-slot="session-turn-diff-path">
                                      <Show when={diff.file.includes("/")}>
                                        <span data-slot="session-turn-diff-directory">
                                          {`\u202A${getDirectory(diff.file)}\u202C`}
                                        </span>
                                      </Show>
                                      <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                                    </span>
                                    <div data-slot="session-turn-diff-meta">
                                      <span data-slot="session-turn-diff-changes">
                                        <DiffChanges changes={diff} />
                                      </span>
                                      <span data-slot="session-turn-diff-chevron">
                                        <Icon name="chevron-down" size="small" />
                                      </span>
                                    </div>
                                  </div>
                                </Accordion.Trigger>
                              </StickyAccordionHeader>
                              <Accordion.Content>
                                <Show when={shown()}>
                                  <div data-slot="session-turn-diff-view" data-scrollable>
                                    <Dynamic
                                      component={fileComponent}
                                      mode="diff"
                                      before={{ contents: view.before }}
                                      after={{ contents: view.after }}
                                    />
                                  </div>
                                </Show>
                              </Accordion.Content>
                            </Accordion.Item>
                          )
                        }}
                      </For>
                    </Accordion>
                    <Show when={!showAll() && overflow() > 0}>
                      <div data-slot="session-turn-diffs-more" onClick={toggleAll}>
                        {i18n.t("ui.sessionTurn.diffs.more", { count: String(overflow()) })}
                      </div>
                    </Show>
                  </div>
                </div>
              </Show>
              <Show when={error()}>
                <Card variant="error" class="error-card">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">{errorText()}</div>
                    <Show when={props.onRetry && status().type === "idle" && !isContextOverflow()}>
                      <Tooltip value={i18n.t("ui.sessionTurn.error.retry")} placement="top" gutter={4}>
                        <button
                          data-slot="session-turn-error-retry"
                          aria-label={i18n.t("ui.sessionTurn.error.retry")}
                          class="shrink-0 p-1 text-text-weakest hover:text-text-weak transition-colors rounded-[4px] hover:bg-surface-base-active"
                          onClick={(e) => {
                            e.stopPropagation()
                            props.onRetry?.()
                          }}
                        >
                          <Icon name="retry" size="small" />
                        </button>
                      </Tooltip>
                    </Show>
                  </div>
                  <Show when={isContextOverflow()}>
                    <div class="mt-2 text-12-regular text-text-weak">
                      {i18n.t("ui.sessionTurn.error.contextTooLarge")}
                    </div>
                  </Show>
                </Card>
              </Show>
            </div>
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  )
}
