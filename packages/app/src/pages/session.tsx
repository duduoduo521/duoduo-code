import type { Project, UserMessage } from "@duoduo-ai/sdk/v2"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { createQuery, skipToken, useMutation, useQueryClient } from "@tanstack/solid-query"
import {
  batch,
  onCleanup,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  on,
  onMount,
  untrack,
  createResource,
  createSignal,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { ResizeHandle } from "@duoduo-ai/ui/resize-handle"
import { Tabs } from "@duoduo-ai/ui/tabs"
import { createAutoScroll } from "@duoduo-ai/ui/hooks"
import { previewSelectedLines } from "@duoduo-ai/ui/pierre/selection-bridge"
import { Button } from "@duoduo-ai/ui/button"
import { showToast } from "@duoduo-ai/ui/toast"
import { checksum } from "@duoduo-ai/shared/util/encode"
import { useSearchParams } from "@solidjs/router"
import { NewSessionView, SessionHeader } from "@/components/session"
import { useComments } from "@/context/comments"
import { getSessionPrefetch, SESSION_PREFETCH_TTL } from "@/context/global-sync/session-prefetch"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { usePermission } from "@/context/permission"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { createSessionComposerState, SessionComposerRegion } from "@/pages/session/composer"
import {
  createOpenReviewFile,
  createSessionTabs,
  createSizing,
  focusTerminalById,
  shouldFocusTerminalOnKeyDown,
} from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { type DiffStyle, SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
import { useSessionLayout } from "@/pages/session/session-layout"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { PreviewPanel } from "@/pages/session/preview-panel"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { diffs as list } from "@/utils/diffs"
import { extractPromptFromParts } from "@/utils/prompt"
import { same } from "@/utils/same"
import { formatServerError } from "@/utils/server-errors"

const emptyUserMessages: UserMessage[] = []

type ChangeMode = "git" | "branch" | "turn"
type VcsMode = "git" | "branch"

type SessionHistoryWindowInput = {
  sessionID: () => string | undefined
  messagesReady: () => boolean
  loaded: () => number
  visibleUserMessages: () => UserMessage[]
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  userScrolled: () => boolean
  scroller: () => HTMLDivElement | undefined
  suspendFollow: () => void
  resumeFollow: () => void
  markProgrammaticScroll: (top?: number) => void
}

/**
 * Maintains the rendered history window for a session timeline.
 *
 * It keeps initial paint bounded to recent turns, reveals cached turns in
 * small batches while scrolling upward, and prefetches older history near top.
 */
function createSessionHistoryWindow(input: SessionHistoryWindowInput) {
  const turnInit = 10
  const turnBatch = 8
  const turnScrollThreshold = 200
  const turnPrefetchBuffer = 16
  const prefetchCooldownMs = 400
  const prefetchNoGrowthLimit = 2

  const [state, setState] = createStore({
    turnID: undefined as string | undefined,
    turnStart: 0,
    turnEnd: 0,
    prefetchUntil: 0,
    prefetchNoGrowth: 0,
  })

  const initialTurnStart = (len: number) => (len > turnInit ? len - turnInit : 0)

  const turnStart = createMemo(() => {
    const id = input.sessionID()
    const len = input.visibleUserMessages().length
    if (!id || len <= 0) return 0
    if (state.turnID !== id) return initialTurnStart(len)
    if (state.turnStart <= 0) return 0
    if (state.turnStart >= len) return initialTurnStart(len)
    return state.turnStart
  })

  // Lower window bound. Defaults to the full list length (unbounded below)
  // until an explicit bound is set, so `slice(start, end)` behaves like the
  // previous `slice(start)` until trimming kicks in.
  const turnEnd = createMemo(() => {
    const id = input.sessionID()
    const len = input.visibleUserMessages().length
    if (!id || len <= 0) return 0
    if (state.turnID !== id) return len
    if (state.turnEnd <= 0) return len
    if (state.turnEnd > len) return len
    return state.turnEnd
  })

  const setTurnStart = (start: number) => {
    const id = input.sessionID()
    const next = start > 0 ? start : 0
    if (!id) {
      setState({ turnID: undefined, turnStart: next })
      return
    }
    setState({ turnID: id, turnStart: next })
  }

  const setTurnEnd = (end: number) => {
    const id = input.sessionID()
    const len = input.visibleUserMessages().length
    const next = end > len ? len : end < 0 ? 0 : end
    if (!id) {
      setState({ turnID: undefined, turnEnd: next })
      return
    }
    setState({ turnID: id, turnEnd: next })
  }

  const renderedUserMessages = createMemo(
    () => {
      const msgs = input.visibleUserMessages()
      const start = turnStart()
      const end = turnEnd()
      if (start <= 0 && end >= msgs.length) return msgs
      return msgs.slice(start, end)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )

  let preserving = false

  const preserveScroll = (fn: () => void) => {
    const el = input.scroller()
    if (!el) {
      fn()
      return
    }
    preserving = true
    // Suppress the auto-scroll ResizeObserver so it does not fight
    // the scrollTop adjustment we are about to make.
    input.suspendFollow()
    const prevOverflowAnchor = el.style.overflowAnchor
    el.style.overflowAnchor = "none"
    const beforeTop = el.scrollTop
    const beforeHeight = el.scrollHeight
    fn()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const afterHeight = el.scrollHeight
        const delta = afterHeight - beforeHeight
        if (delta) {
          const max = Math.max(0, el.scrollHeight - el.clientHeight)
          const next = Math.min(Math.max(0, beforeTop + delta), max)
          // Mark as programmatic AT the position we are about to land on. The
          // old code marked the bottom unconditionally: whenever the window
          // shift moved the viewport upwards the mark mismatched the real
          // scrollTop, so handleScroll treated our own scroll as the user
          // scrolling away and permanently disabled auto-follow.
          input.markProgrammaticScroll(next)
          el.scrollTop = next
        }
        el.style.overflowAnchor = prevOverflowAnchor
        input.resumeFollow()
        preserving = false
      })
    })
  }

  const backfillTurns = () => {
    const start = turnStart()
    if (start <= 0) return

    const next = start - turnBatch
    const nextStart = next > 0 ? next : 0

    preserveScroll(() => setTurnStart(nextStart))
  }

  /** Button path: reveal all cached turns, fetch older history, reveal one batch. */
  const loadAndReveal = async () => {
    const id = input.sessionID()
    if (!id) return

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    let loaded = input.loaded()

    if (start > 0) {
      setTurnStart(0)
      setTurnEnd(input.visibleUserMessages().length)
    }

    if (!input.historyMore() || input.historyLoading()) return

    let afterVisible = beforeVisible
    let added = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      afterVisible = input.visibleUserMessages().length
      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded

      if (afterVisible > beforeVisible) break
      if (raw <= 0) break
      if (!input.historyMore()) break
    }

    if (added <= 0) return
    if (state.prefetchNoGrowth) setState("prefetchNoGrowth", 0)

    const growth = afterVisible - beforeVisible
    if (growth <= 0) return
    if (turnStart() !== 0) return

    const target = Math.min(afterVisible, beforeVisible + turnBatch)
    setTurnStart(Math.max(0, afterVisible - target))
    setTurnEnd(afterVisible)
  }

  /** Scroll/prefetch path: fetch older history from server. */
  const fetchOlderMessages = async (opts?: { prefetch?: boolean }) => {
    const id = input.sessionID()
    if (!id) return
    if (!input.historyMore() || input.historyLoading()) return

    if (opts?.prefetch) {
      const now = Date.now()
      if (state.prefetchUntil > now) return
      if (state.prefetchNoGrowth >= prefetchNoGrowthLimit) return
      setState("prefetchUntil", now + prefetchCooldownMs)
    }

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    const beforeRendered = start <= 0 ? beforeVisible : renderedUserMessages().length
    let loaded = input.loaded()
    let added = 0
    let growth = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded
      growth = input.visibleUserMessages().length - beforeVisible

      if (growth > 0) break
      if (raw <= 0) break
      if (opts?.prefetch) break
      if (!input.historyMore()) break
    }

    const afterVisible = input.visibleUserMessages().length

    if (opts?.prefetch) {
      setState("prefetchNoGrowth", added > 0 ? 0 : state.prefetchNoGrowth + 1)
    } else if (added > 0 && state.prefetchNoGrowth) {
      setState("prefetchNoGrowth", 0)
    }

    if (added <= 0) return
    if (growth <= 0) return

    if (opts?.prefetch) {
      const current = turnStart()
      // Older history is prepended (mode: "prepend"), shifting every index up
      // by `growth`. Shift both bounds so the visible window stays put.
      preserveScroll(() => {
        setTurnStart(current + growth)
        setTurnEnd(turnEnd() + growth)
      })
      return
    }

    if (turnStart() !== start) return

    const currentRendered = renderedUserMessages().length
    const base = Math.max(beforeRendered, currentRendered)
    const target = Math.min(afterVisible, base + turnBatch)
    preserveScroll(() => {
      setTurnStart(Math.max(0, afterVisible - target))
      // Release any bottom bound so the revealed window spans down to the
      // newest loaded turn (mirrors the previous `slice(start)` behaviour).
      setTurnEnd(afterVisible)
    })
  }

  const onScrollerScroll = () => {
    // Skip while preserveScroll is adjusting scrollTop to avoid
    // triggering a cascading backfill loop.
    if (preserving) return
    const el = input.scroller()
    if (!el) return
    if (el.scrollTop >= turnScrollThreshold) return

    // Near-top: always attempt backfill regardless of userScrolled flag
    // to prevent blank-page scenario where the flag was incorrectly reset
    if (!input.userScrolled() && el.scrollTop > 50) return

    const start = turnStart()
    if (start > 0) {
      if (start <= turnPrefetchBuffer) {
        void fetchOlderMessages({ prefetch: true })
      }
      backfillTurns()
      return
    }

    void fetchOlderMessages()
  }

  createEffect(
    on(
      input.sessionID,
      () => {
        setState({ prefetchUntil: 0, prefetchNoGrowth: 0 })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [input.sessionID(), input.messagesReady()] as const,
      ([id, ready]) => {
        if (!id || !ready) return
        setTurnStart(initialTurnStart(input.visibleUserMessages().length))
      },
      { defer: true },
    ),
  )

  // Bound the rendered window so the DOM never grows unbounded regardless of
  // session length or scroll position. Trimming only fires when content
  // overflows by >= ~2 screens, so any dropped turn is always >= 1 screen away
  // from the viewport and `preserveScroll` keeps the viewport anchored with no
  // visible jump. A smaller window also lets message-timeline release parts
  // outside it, bounding memory.
  const WINDOW_CAP = turnInit * 2
  createEffect(() => {
    const id = input.sessionID()
    if (!id) return
    const len = input.visibleUserMessages().length
    const start = turnStart()
    const end = turnEnd()
    const rendered = renderedUserMessages().length
    const el = input.scroller()
    if (!el) return
    // Require real overflow (>= ~2 screens) before trimming, so removed turns are
    // never visible. Also avoids fighting `fill` (short content).
    if (el.scrollHeight <= el.clientHeight * 2) return
    if (rendered <= WINDOW_CAP) return

    if (!input.userScrolled()) {
      // Following the bottom: anchor on the newest turns and slide the top back.
      const maxStart = len > WINDOW_CAP ? len - WINDOW_CAP : 0
      if (start < maxStart || end < len) {
        preserveScroll(() => {
          if (end < len) setTurnEnd(len)
          if (start < maxStart) setTurnStart(maxStart)
        })
      }
      return
    }

    // User scrolled away from the bottom: bind the window to WINDOW_CAP turns,
    // keeping the end nearest the viewport fixed so the visible region stays put.
    const scrollable = el.scrollHeight - el.clientHeight
    const nearTop = scrollable <= 0 || el.scrollTop < scrollable * 0.5
    if (nearTop) {
      // Viewport near the window top: drop turns below the viewport.
      const nextEnd = Math.min(len, start + WINDOW_CAP)
      if (nextEnd !== end) preserveScroll(() => setTurnEnd(nextEnd))
    } else {
      // Viewport near the window bottom: drop turns above the viewport.
      const nextStart = Math.max(0, end - WINDOW_CAP)
      if (nextStart !== start) preserveScroll(() => setTurnStart(nextStart))
    }
  })

  return {
    turnStart,
    setTurnStart,
    turnEnd,
    setTurnEnd,
    renderedUserMessages,
    loadAndReveal,
    onScrollerScroll,
  }
}

export default function Page() {
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const queryClient = useQueryClient()
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const settings = useSettings()
  const permission = usePermission()
  const prompt = usePrompt()
  const notification = useNotification()
  const comments = useComments()
  const terminal = useTerminal()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const { params, sessionKey, tabs, view } = useSessionLayout()

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      if (params.id) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    reviewSnap: false,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
      jump: false,
    },
  })

  const composer = createSessionComposerState()

  const workspaceKey = createMemo(() => params.dir ?? "")
  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  // 固定使用桌面布局：按需求移除 768px 响应式断点，
  // 审查标签（review tab）与侧栏在任何窗口宽度下都固定显示。
  const isDesktop = () => true
  const size = createSizing()
  const desktopReviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const desktopFileTreeOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const desktopSidePanelOpen = createMemo(() => desktopReviewOpen() || desktopFileTreeOpen())
  const sessionPanelWidth = createMemo(() => {
    if (!desktopSidePanelOpen()) return "100%"
    if (desktopReviewOpen()) return `${layout.session.width()}px`
    return `calc(100% - ${layout.fileTree.width()}px)`
  })
  const centered = createMemo(() => isDesktop() && !desktopReviewOpen())

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const isChildSession = createMemo(() => !!info()?.parentID)
  const diffs = createMemo(() => (params.id ? list(sync.data.session_diff[params.id]) : []))
  const isRemote = createMemo(() => sync.project?.id.startsWith("remote:") ?? false)
  const canReview = createMemo(() => !!sync.project && !isRemote())
  const reviewTab = createMemo(() => isDesktop() && !isRemote())
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    // 审查标签固定显示：不再依赖项目是否打开
    hasReview: () => true,
  })
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })

  // Fallback retry: if messagesReady stays false for a session that should have
  // messages (e.g. after Provider rebuild), force a re-sync to recover.
  // Capped at 3 attempts to avoid infinite retries when the server is unreachable.
  let retryCount = 0
  const MAX_RETRY = 3
  createEffect(() => {
    const id = params.id
    if (!id || messagesReady()) {
      retryCount = 0
      return
    }
    if (retryCount >= MAX_RETRY) return
    const timer = setTimeout(() => {
      if (!id || sync.data.message[id] !== undefined) return
      retryCount++
      void sync.session.sync(id, { force: true })
    }, 500)
    onCleanup(() => clearTimeout(timer))
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })
  const userMessages = createMemo(() => messages().filter((m) => m.role === "user"), emptyUserMessages, {
    equals: same,
  })
  // Message id of a turn that is being replaced by an identical re-send (retry
  // button / edit-and-resend). While it is set the timeline keeps rendering that
  // turn until its replacement exists, instead of dropping it the moment
  // `revert` is recorded — the drop/re-create gap empties the scroll content and
  // resets scrollTop to 0, which reads as "the page jumped to the top".
  const [resend, setResend] = createSignal<string | undefined>()

  createEffect(
    on(
      revertMessageID,
      (id) => {
        if (!id) setResend(undefined)
      },
      { defer: true },
    ),
  )

  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      const all = userMessages()
      if (!revert) return all
      const pending = resend()
      if (!pending) return all.filter((m) => m.id < revert)
      // Re-send in flight: render everything until the replacement turn exists,
      // then switch to it in a single update so the list is never empty.
      const next = all.findIndex((m) => m.id > pending)
      if (next < 0) return all
      return all.slice(next)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  // Stale threshold: if a file was loaded more than this many ms ago,
  // force reload to catch changes that may have been missed when the
  // watcher (SSE) was disconnected or unavailable.
  const STALE_THRESHOLD_MS = 60_000 // 1 minute

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (!path) return
    const state = file.get(path)
    // Force reload when the file is marked stale (watcher detected a change)
    // or when content was loaded too long ago (catches SSE gaps / watcher failures).
    const isStale = state?.stale ?? false
    const isOld = state?.loadedAt ? Date.now() - state.loadedAt > STALE_THRESHOLD_MS : !state?.loaded
    void file.load(path, { force: isStale || isOld })
  })

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  createEffect(
    on(
      () => ({ dir: params.dir, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) {
          local.session.reset()
          // Preserve file tabs from the previous session so the side panel
          // doesn't close all tabs when navigating to the new-session page.
          const prevKey = `${prev.dir}/${prev.id}`
          const prevTabs = layout.tabs(prevKey)
          const current = prevTabs.tabs()
          if (current.all.length > 0) {
            const workspace = layout.tabs(next.dir ?? "")
            // Only transfer if workspace tabs are empty (no pending handoff)
            if (workspace.tabs().all.length === 0 && !workspace.tabs().active) {
              workspace.setAll(current.all)
              if (current.active) workspace.setActive(current.active)
            }
          }
        }
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    messageId: undefined as string | undefined,
    mobileTab: "session" as "session" | "changes",
    changes: "git" as ChangeMode,
    newSessionWorktree: "main",
  })

  let reviewFrame: number | undefined
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  let todoFrame: number | undefined
  let todoTimer: number | undefined
  let diffFrame: number | undefined
  let diffTimer: number | undefined

  createEffect((prev) => {
    const open = desktopReviewOpen()
    if (prev === undefined || prev === open) return open

    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    setUi("reviewSnap", true)
    reviewFrame = requestAnimationFrame(() => {
      reviewFrame = undefined
      setUi("reviewSnap", false)
    })
    return open
  }, desktopReviewOpen())

  const turnDiffs = createMemo(() => list(lastUserMessage()?.summary?.diffs))
  const nogit = createMemo(() => !!sync.project && sync.project.vcs !== "git")
  const changesOptions = createMemo<ChangeMode[]>(() => {
    if (sync.project?.vcs === "git") return ["git"]
    return []
  })
  const mobileChanges = createMemo(() => !isDesktop() && store.mobileTab === "changes")
  const wantsReview = createMemo(() =>
    isDesktop()
      // 审查面板已固定显示（desktopReviewOpen），面板可见即应拉取变更数据，
      // 不再要求当前激活 tab 必须是 review，否则面板常驻但内容永空白。
      ? desktopFileTreeOpen() || desktopReviewOpen()
      : store.mobileTab === "changes",
  )
  const vcsMode = createMemo<VcsMode | undefined>(() => {
    // 优先 project.vcs；兜底用 vcs store 的 branch 信息（打开仓库子目录时
    // sync.project 可能因匹配失败而缺 vcs，但 /vcs 接口仍能确认是 git 仓库）。
    // 审查面板已可见时直接按 git 处理，非 git 仓库后端 vcs.diff 会自行返回空。
    if (sync.project?.vcs === "git" || !!sync.data.vcs?.branch || wantsReview()) return "git"
  })
  const vcsKey = createMemo(
    () => ["session-vcs", sdk.directory, sync.data.vcs?.branch ?? "", sync.data.vcs?.default_branch ?? ""] as const,
  )
  const vcsQuery = createQuery(() => {
    const mode = vcsMode()
    // 审查面板已可见即拉取变更；git 仓库判定交由 vcsMode 处理，非 git 仓库时
    // 后端 vcs.diff 会自行返回空，无需在此阻塞（避免依赖延迟填充的 vcs store）。
    const enabled = wantsReview()

    return {
      queryKey: [...vcsKey(), mode] as const,
      enabled,
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 60 * 1000,
      retry: 2,
      retryDelay: 1000,
      queryFn: mode
        ? () =>
            sdk.client.vcs
              .diff({ mode })
              .then((result) => list(result.data))
              .catch((error) => {
                console.debug("[session-review] failed to load vcs diff", { mode, error })
                return []
              })
        : skipToken,
    }
  })
  // Debounce VCS refreshes — rapid file changes (e.g. Agent writing multiple
  // files) can produce a burst of watcher events; coalescing them avoids
  // redundant git-diff API calls and prevents the query from oscillating
  // between isPending / isFetched.
  let vcsRefreshTimer: ReturnType<typeof setTimeout> | undefined
  const refreshVcs = () => {
    if (vcsRefreshTimer !== undefined) return
    vcsRefreshTimer = setTimeout(() => {
      vcsRefreshTimer = undefined
      void queryClient.invalidateQueries({ queryKey: vcsKey() })
    }, 500)
  }
  const reviewDiffs = () => {
    console.debug("[session-review] sync.project?.vcs=", sync.project?.vcs,
      " sync.data.vcs?.branch=", sync.data.vcs?.branch,
      " isFetched=", vcsQuery.isFetched,
      " data.len=", (vcsQuery.data ?? []).length)
    // 用 vcs store 的 branch 信息判断是否为 git 仓库，比依赖 sync.project 的
    // vcs 字段更健壮（打开仓库子目录时 sync.project 可能因匹配失败而缺 vcs）。
    const isGit = sync.project?.vcs === "git" || !!sync.data.vcs?.branch
    if (isGit)
      // avoids suspense
      return vcsQuery.isFetched ? (vcsQuery.data ?? []) : []
    return turnDiffs()
  }
  const reviewCount = () => reviewDiffs().length
  const hasReview = () => reviewCount() > 0
  const reviewReady = () => {
    if (sync.project?.vcs === "git") return !vcsQuery.isPending
    return true
  }

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync.project
    if (project && sdk.directory !== project.worktree) return sdk.directory
    return "main"
  })

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex]!, "auto")
  }

  function upsert(next: Project) {
    const list = globalSync.data.project
    sync.set("project", next.id)
    const idx = list.findIndex((item) => item.id === next.id)
    if (idx >= 0) {
      globalSync.set(
        "project",
        list.map((item, i) => (i === idx ? { ...item, ...next } : item)),
      )
      return
    }
    const at = list.findIndex((item) => item.id > next.id)
    if (at >= 0) {
      globalSync.set("project", [...list.slice(0, at), next, ...list.slice(at)])
      return
    }
    globalSync.set("project", [...list, next])
  }

  const gitMutation = useMutation(() => ({
    mutationFn: () => sdk.client.project.initGit(),
    onSuccess: (x) => {
      if (!x.data) return
      upsert(x.data)
    },
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
    },
  }))

  function initGit() {
    if (gitMutation.isPending) return
    gitMutation.mutate()
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let scrollMark = 0
  let messageMark = 0

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  const [sessionSync] = createResource(
    () => [sdk.directory, params.id] as const,
    ([directory, id]) => {
      if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshFrame = undefined
      refreshTimer = undefined
      if (!id) return

      const cached = untrack(() => sync.data.message[id] !== undefined)
      const stale = !cached
        ? false
        : (() => {
            const info = getSessionPrefetch(directory, id)
            if (!info) return true
            return Date.now() - info.at > SESSION_PREFETCH_TTL
          })()

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (params.id !== id) return
          untrack(() => {
            if (stale) void sync.session.sync(id, { force: true })
          })
        }, 0)
      })

      return sync.session.sync(id)
    },
  )

  createEffect(
    on(
      () => {
        const id = params.id
        return [
          sdk.directory,
          id,
          id ? (sync.data.session_status[id]?.type ?? "idle") : "idle",
          id ? composer.blocked() : false,
        ] as const
      },
      ([dir, id, status, blocked]) => {
        if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
        if (todoTimer !== undefined) window.clearTimeout(todoTimer)
        todoFrame = undefined
        todoTimer = undefined
        if (!id) return
        if (status === "idle" && !blocked) return
        const hasCache = untrack(
          () => sync.data.todo[id] !== undefined || globalSync.data.session_todo[id] !== undefined,
        )
        if (hasCache) return

        todoFrame = requestAnimationFrame(() => {
          todoFrame = undefined
          todoTimer = window.setTimeout(() => {
            todoTimer = undefined
            if (sdk.directory !== dir || params.id !== id) return
            untrack(() => {
              void sync.session.todo(id)
            })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("changes", "git" as ChangeMode)
        setUi("pendingMessage", undefined)
        autoScroll.forceScrollToBottom()
      },
      { defer: true },
    ),
  )

  const stopVcs = sdk.event.listen((evt) => {
    if (evt.details.type !== "file.watcher.updated") return
    const props =
      typeof evt.details.properties === "object" && evt.details.properties
        ? (evt.details.properties as Record<string, unknown>)
        : undefined
    const file = typeof props?.file === "string" ? props.file : undefined
    // Ignore all .git/ internal events. Branch changes are already detected
    // by the backend Vcs.Service (which subscribes to .git/HEAD via
    // FileWatcher) and propagated to the frontend via the
    // "vcs.branch.updated" SSE event. Allowing .git/HEAD watcher events
    // to trigger refreshVcs() here creates an infinite loop:
    // refreshVcs() → git diff API → git reads .git/index/HEAD →
    // watcher fires → refreshVcs() → ...
    if (!file || file.startsWith(".git/")) return
    refreshVcs()
  })
  onCleanup(stopVcs)

  // Refresh VCS when the page becomes visible again (e.g. user switched to
  // GitHub Desktop to commit, then switched back to the IDE).
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      refreshVcs()
      // 切回可见时，若用户未主动上滚（userScrolled=false），强制贴底。
      // 后台标签下 rAF/ResizeObserver 暂停、overflowAnchor="none" 不自动锚定，
      // 恢复时只能靠 RO 脆弱自愈（偶发卡在中间）。此处显式重同步以消除随机性。
      requestAnimationFrame(() => {
        if (!autoScroll.userScrolled()) autoScroll.forceScrollToBottom()
      })
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange)
  onCleanup(() => document.removeEventListener("visibilitychange", onVisibilityChange))

  // Periodic VCS refresh as a fallback for missed watcher events (e.g. SSE
  // reconnection). Only runs when a review panel is open.
  createEffect(() => {
    if (!wantsReview()) return
    const id = setInterval(refreshVcs, 30_000)
    onCleanup(() => clearInterval(id))
  })

  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
        autoScroll.forceScrollToBottom()
      },
      { defer: true },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(input.preview ? { preview: input.preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    // Prefer the open terminal over the composer when it can take focus
    if (view().terminal.opened()) {
      const id = terminal.active()
      if (id && shouldFocusTerminalOnKeyDown(event) && focusTerminalById(id)) return
    }

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (composer.blocked() || isChildSession()) return
      inputRef?.focus()
    }
  }

  createEffect(() => {
    const list = changesOptions()
    if (list.includes(store.changes)) return
    const next = list[0]
    if (!next) return
    setStore("changes", next)
  })

  createEffect(
    on(
      () => sync.data.session_status[params.id ?? ""]?.type,
      (next, prev) => {
        if (next !== "idle" || prev === undefined || prev === "idle") return
        refreshVcs()
        // 用户已上滚阅读历史时，会话结束不再强制跳到底部；
        // 底部"回到最新"按钮（由 userScrolled 驱动）仍可供手动返回。
        if (!autoScroll.userScrolled()) {
          autoScroll.forceScrollToBottom()
          // 任务3：diff/代码块/图片等延迟挂载内容在 forceScrollToBottom 之后才撑高
          // scrollHeight，用 rAF 连帧 + 延迟兜底再滚动几次以贴合真实底部。
          requestAnimationFrame(() => {
            autoScroll.forceScrollToBottom()
            requestAnimationFrame(() => autoScroll.forceScrollToBottom())
          })
          const followUp = setTimeout(() => autoScroll.forceScrollToBottom(), 250)
          onCleanup(() => clearTimeout(followUp))
        }
      },
      { defer: true },
    ),
  )

  const fileTreeTab = () => layout.fileTree.tab()

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({
          reviewScroll: undefined,
          pendingDiff: undefined,
          activeDiff: undefined,
        })
      },
      { defer: true },
    ),
  )

  const focusInput = () => {
    if (isChildSession()) return
    inputRef?.focus()
  }

  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
    review: reviewTab,
  })

  const openReviewFile = createOpenReviewFile({
    tabForPath: file.tab,
    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    openTab: tabs().open,
    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    setActive: tabs().setActive,
    loadFile: file.load,
  })

  const changesTitle = () => {
    if (!canReview()) {
      return null
    }
    if (sync.project?.vcs !== "git") return null
    return <span class="text-14-medium">{language.t("ui.sessionReview.title.git")}</span>
  }

  const empty = (text: string) => (
    <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
      <div class="text-14-regular text-text-weak max-w-56">{text}</div>
    </div>
  )

  const createGit = (input: { emptyClass: string }) => (
    <div class={input.emptyClass}>
      <div class="flex flex-col items-center gap-4 text-center">
        <div class="size-12 rounded-full bg-surface-raised-base flex items-center justify-center text-20-regular text-text-base">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M6 21V9a9 9 0 0 0 9 9" />
          </svg>
        </div>
        <div class="flex flex-col gap-2">
          <div class="text-14-medium text-text-strong">{language.t("session.review.noVcs.createGit.title")}</div>
          <div class="text-13-regular text-text-base max-w-xs" style={{ "line-height": "var(--line-height-normal)" }}>
            {language.t("session.review.noVcs.createGit.description")}
          </div>
        </div>
      </div>
      <Button size="large" disabled={gitMutation.isPending} onClick={initGit}>
        {gitMutation.isPending
          ? language.t("session.review.noVcs.createGit.actionLoading")
          : language.t("session.review.noVcs.createGit.action")}
      </Button>
    </div>
  )

  const reviewEmptyText = createMemo(() => {
    if (sync.project?.vcs === "git") return language.t("session.review.noUncommittedChanges")
    return language.t("session.review.noChanges")
  })

  const reviewEmpty = (input: { loadingClass: string; emptyClass: string }) => {
    if (sync.project?.vcs === "git") {
      if (!reviewReady()) return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
      return empty(reviewEmptyText())
    }
    if (nogit()) return createGit(input)
    return empty(reviewEmptyText())
  }

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Show keyed when={sessionKey()}>
      <SessionReviewTab
        title={changesTitle()}
        empty={reviewEmpty(input)}
        diffs={reviewDiffs}
        view={view}
        diffStyle={input.diffStyle}
        onDiffStyleChange={input.onDiffStyleChange}
        onScrollRef={(el) => setTree("reviewScroll", el)}
        focusedFile={tree.activeDiff}
        onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
        onLineCommentUpdate={updateCommentInContext}
        onLineCommentDelete={removeCommentFromContext}
        lineCommentActions={reviewCommentActions()}
        commentMentions={{
          items: file.searchFilesAndDirectories,
        }}
        comments={comments.all()}
        focusedComment={comments.focus()}
        onFocusedCommentChange={comments.setFocus}
        onViewFile={openReviewFile}
        classes={input.classes}
      />
    </Show>
  )

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!reviewReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  createEffect(() => {
    const id = params.id
    if (!id) return

    if (!wantsReview()) return
    if (sync.data.session_diff[id] !== undefined) return
    if (sync.status === "loading") return

    void sync.session.diff(id)
  })

  createEffect(
    on(
      () => [sessionKey(), wantsReview()] as const,
      ([key, wants]) => {
        if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
        if (diffTimer !== undefined) window.clearTimeout(diffTimer)
        diffFrame = undefined
        diffTimer = undefined
        if (!wants) return

        const id = params.id
        if (!id) return
        if (!untrack(() => sync.data.session_diff[id] !== undefined)) return

        diffFrame = requestAnimationFrame(() => {
          diffFrame = undefined
          diffTimer = window.setTimeout(() => {
            diffTimer = undefined
            if (sessionKey() !== key) return
            void sync.session.diff(id, { force: true })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk.directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync.status === "loading") return

    fileTreeTab()
    // With global file tree caching, list() returns immediately when the
    // directory is already loaded in cache. No force refresh needed —
    // watcher events keep background caches up to date.
    const isNewProject = treeDir !== dir
    treeDir = dir
    void (isNewProject ? file.tree.list("") : file.tree.list(""))
  })

  // Dismiss the remote opening overlay only once the file tree has listed its
  // root directory (so files are actually visible) or the listing errored out
  // (avoid a permanent stuck overlay). Loaded/error are mutually exclusive
  // terminal states of a directory listing.
  createEffect(() => {
    const root = file.tree.state("")
    if (root && (root.loaded || root.error)) layout.setOpeningRemote(false)
  })

  createEffect(
    on(
      () => sdk.directory,
      () => {
        const tab = activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
  })

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined

  // 溢出且明显不在底部即显示"回到底部"按钮（25% 视口或 120px，取小者），
  // 避免原阈值 max(400, clientHeight) 在小溢出/高视口下按钮永不出现。
  const jumpThreshold = (el: HTMLDivElement) => Math.min(120, el.clientHeight * 0.25)

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    const overflow = max > 1
    const bottom = !overflow || distance <= 2
    const jump = overflow && distance > jumpThreshold(el)

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
    setUi("scroll", { overflow, bottom, jump })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.forceScrollToBottom()
    clearMessageHash()

    const el = scroller
    if (el) {
      scheduleScrollState(el)
      // 发送时刻用户消息与流式内容尚未挂载，forceScrollToBottom 计算的 scrollHeight
      // 还不包含新内容；内容随后才撑高 scrollHeight。用 rAF 连帧 + 延迟兜底再滚动几次，
      // 确保贴合真实底部（与 idle 处理保持一致，否则会停在旧底部需要手动滚动）。
      requestAnimationFrame(() => {
        autoScroll.forceScrollToBottom()
        requestAnimationFrame(() => autoScroll.forceScrollToBottom())
      })
      setTimeout(() => autoScroll.forceScrollToBottom(), 250)
    }
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let fill = () => {}

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const historyWindow = createSessionHistoryWindow({
    sessionID: () => params.id,
    messagesReady,
    loaded: () => messages().length,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    userScrolled: autoScroll.userScrolled,
    scroller: () => scroller,
    suspendFollow: autoScroll.suspendFollow,
    resumeFollow: autoScroll.resumeFollow,
    markProgrammaticScroll: autoScroll.markProgrammaticScroll,
  })

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (historyWindow.turnStart() <= 0 && !historyMore()) return

      void historyWindow.loadAndReveal()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyWindow.turnStart(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleUserMessages().length,
        ] as const,
      ([id, ready, start, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (start <= 0 && !more) return
        fill()
      },
      { defer: true },
    ),
  )

  const draft = (id: string) =>
    extractPromptFromParts(sync.data.part[id] ?? [], {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
      .map((part) =>
        part.type === "image"
          ? `[image:${part.filename}]`
          : part.type === "text-file"
            ? `[file:${part.filename}]`
            : "content" in part
              ? part.content
              : "",
      )
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const merge = (next: NonNullable<ReturnType<typeof info>>) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === next.id)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = next
      return out
    })

  const roll = (sessionID: string, next: NonNullable<ReturnType<typeof info>>["revert"]) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === sessionID)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = { ...out[idx]!, revert: next }
      return out
    })

  const busy = (sessionID: string) => {
    // session_status comes from the server via SSE and periodic API
    // refreshes.  When the server says "idle" the session is not
    // running — any local message cache that still shows an
    // unfinished assistant message is stale (e.g. missed
    // message.updated event during an SSE reconnect) and must not
    // keep the UI stuck in "busy".
    const serverStatus = (sync.data.session_status[sessionID] ?? { type: "idle" as const }).type
    if (serverStatus === "retry") return true
    if (serverStatus === "busy") return true
    // server says idle — trust the server over local cache
    return false
  }

  const halt = (sessionID: string) => sdk.client.session.abort({ sessionID }).catch(() => {})

  const revertMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; messageID: string }) => {
      const prev = prompt.current().slice()
      const last = info()?.revert
      const value = draft(input.messageID)
      batch(() => {
        roll(input.sessionID, { messageID: input.messageID })
        prompt.set(value)
      })
      await halt(input.sessionID)
        .then(() => sdk.client.session.revert(input))
        .then((result) => {
          if (result.data) merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            roll(input.sessionID, last)
            prompt.set(prev)
          })
          fail(err)
        })
    },
  }))

  const restoreMutation = useMutation(() => ({
    mutationFn: async (id: string) => {
      const sessionID = params.id
      if (!sessionID) return

      const next = userMessages().find((item) => item.id > id)
      const prev = prompt.current().slice()
      const last = info()?.revert

      batch(() => {
        roll(sessionID, next ? { messageID: next.id } : undefined)
        if (next) {
          prompt.set(draft(next.id))
          return
        }
        prompt.reset()
      })

      const task = !next
        ? halt(sessionID).then(() => sdk.client.session.unrevert({ sessionID }))
        : halt(sessionID).then(() =>
            sdk.client.session.revert({
              sessionID,
              messageID: next.id,
            }),
          )

      await task
        .then((result) => {
          if (result.data) merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            roll(sessionID, last)
            prompt.set(prev)
          })
          fail(err)
        })
    },
  }))

  const reverting = createMemo(() => revertMutation.isPending || restoreMutation.isPending)
  const restoring = createMemo(() => (restoreMutation.isPending ? restoreMutation.variables : undefined))

  const revert = (input: { sessionID: string; messageID: string }) => {
    if (reverting()) return
    return revertMutation.mutateAsync(input)
  }

  const restore = (id: string) => {
    if (!params.id || reverting()) return
    return restoreMutation.mutateAsync(id)
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    return userMessages()
      .filter((item) => item.id >= id)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  const actions = { revert, markResend: (input: { messageID: string }) => setResend(input.messageID) }

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) autoScroll.forceScrollToBottom()

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    turnStart: historyWindow.turnStart,
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    setTurnStart: historyWindow.setTurnStart,
    turnEnd: historyWindow.turnEnd,
    setTurnEnd: historyWindow.setTurnEnd,
    autoScroll,
    scroller: () => scroller,
    anchor,
    scheduleScrollState,
    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    consumePendingMessage: layout.pendingMessage.consume,
  })

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  // 任务6：会话激活时主动标记已读。layout 的 syncSessionRoute 仅在路由真正变化时才
  // 调用 markViewed；刷新/深链/预选中会话时路由不变会导致项目小蓝点残留，这里兜底清除。
  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) return
        notification.session.markViewed(id)
      },
    ),
  )

  onMount(() => {
    makeEventListener(document, "keydown", handleKeyDown)
  })

  onCleanup(() => {
    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
    if (todoTimer !== undefined) window.clearTimeout(todoTimer)
    if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
    if (diffTimer !== undefined) window.clearTimeout(diffTimer)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  return (
    <div class="relative bg-background-base size-full overflow-hidden flex flex-col">
      {sessionSync() ?? ""}
      <SessionHeader />
      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        <Show when={!isDesktop() && !!params.id}>
          <Tabs value={store.mobileTab} class="h-auto">
            <Tabs.List>
              <Tabs.Trigger
                value="session"
                class="!w-1/2 !max-w-none"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "session")}
              >
                {language.t("session.tab.session")}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="changes"
                class="!w-1/2 !max-w-none !border-r-0"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "changes")}
              >
                {hasReview()
                  ? language.t("session.review.filesChanged", { count: reviewCount() })
                  : language.t("session.review.change.other")}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </Show>

        {/* Session panel */}
        <div
          classList={{
            "@container relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger flex-1 md:flex-none": true,
            "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
              !size.active() && !ui.reviewSnap,
          }}
          style={{
            width: sessionPanelWidth(),
          }}
        >
          <div class="flex-1 min-h-0 overflow-hidden">
            <Switch>
              <Match when={params.id}>
                <Show
                  when={messagesReady()}
                  fallback={
                    <div class="h-full flex items-center justify-center text-text-weak">
                      {language.t("common.loading")}
                    </div>
                  }
                >
                  <MessageTimeline
                    mobileChanges={mobileChanges()}
                    mobileFallback={reviewContent({
                      diffStyle: "unified",
                      classes: {
                        root: "pb-8",
                        header: "px-4",
                        container: "px-4",
                      },
                      loadingClass: "px-4 py-4 text-text-weak",
                      emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
                    })}
                    actions={actions}
                    scroll={ui.scroll}
                    onResumeScroll={resumeScroll}
                    setScrollRef={setScrollRef}
                    onScheduleScrollState={scheduleScrollState}
                    onAutoScrollHandleScroll={autoScroll.handleScroll}
                    onMarkScrollGesture={markScrollGesture}
                    hasScrollGesture={hasScrollGesture}
                    onUserScroll={markUserScroll}
                    onTurnBackfillScroll={historyWindow.onScrollerScroll}
                    onAutoScrollInteraction={autoScroll.handleInteraction}
                    centered={centered()}
                    setContentRef={(el) => {
                      content = el
                      autoScroll.contentRef(el)

                      const root = scroller
                      if (root) scheduleScrollState(root)
                    }}
                    turnStart={historyWindow.turnStart()}
                    historyMore={historyMore()}
                    historyLoading={historyLoading()}
                    onLoadEarlier={() => {
                      void historyWindow.loadAndReveal()
                    }}
                    renderedUserMessages={historyWindow.renderedUserMessages()}
                    anchor={anchor}
                  />
                </Show>
              </Match>
              <Match when={true}>
                <NewSessionView worktree={newSessionWorktree()} />
              </Match>
            </Switch>
          </div>

          <SessionComposerRegion
            state={composer}
            ready={messagesReady()}
            centered={centered()}
            inputRef={(el) => {
              inputRef = el
            }}
            newSessionWorktree={newSessionWorktree()}
            onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
            onSubmit={() => {
              comments.clear()
              resumeScroll()
            }}
            onResponseSubmit={resumeScroll}
            revert={
              rolled().length > 0
                ? {
                    items: rolled(),
                    restoring: restoring(),
                    disabled: reverting(),
                    onRestore: restore,
                  }
                : undefined
            }
            setPromptDockRef={(el) => {
              promptDock = el
            }}
          />

          <Show when={desktopReviewOpen()}>
            <div onPointerDown={() => size.start()}>
              <ResizeHandle
                direction="horizontal"
                size={layout.session.width()}
                min={450}
                max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.45}
                onResize={(width) => {
                  size.touch()
                  layout.session.resize(width)
                }}
              />
            </div>
          </Show>
        </div>

        <SessionSidePanel
          canReview={canReview}
          diffs={reviewDiffs}
          empty={reviewEmptyText}
          hasReview={hasReview}
          reviewCount={reviewCount}
          reviewPanel={reviewPanel}
          reviewSnap={ui.reviewSnap}
          size={size}
        />
      </div>

      <TerminalPanel />
      <PreviewPanel />
    </div>
  )
}
