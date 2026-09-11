import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
  overflowAnchor?: "none" | "auto" | "dynamic"
  bottomThreshold?: number
}

export function createAutoScroll(options: AutoScrollOptions) {
  let settling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  let auto: { top: number; time: number; bottom: boolean } | undefined
  let forceFollowUntil = 0
  // When true the ResizeObserver-driven follow is temporarily suppressed.
  // Used by external code (e.g. preserveScroll) that mutates the DOM and
  // needs to adjust scrollTop without the observer fighting it.
  let suspended = false

  const threshold = () => options.bottomThreshold ?? 10

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    scrollRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })

  const active = () => options.working() || settling

  const distanceFromBottom = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  const canScroll = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight > 1
  }

  // Browsers can dispatch scroll events asynchronously. If new content arrives
  // between us calling `scrollTo()` and the subsequent `scroll` event firing,
  // the handler can see a non-zero `distanceFromBottom` and incorrectly assume
  // the user scrolled.
  // `top === undefined` means "we scrolled to the bottom". An explicit `top` is
  // an arbitrary programmatic position supplied by `markProgrammaticScroll`
  // (e.g. preserveScroll re-anchoring after the turn window shifted); that must
  // be absorbed where it landed, not followed up with another bottom scroll.
  const markAuto = (el: HTMLElement, top?: number) => {
    auto = {
      top: top ?? Math.max(0, el.scrollHeight - el.clientHeight),
      time: Date.now(),
      bottom: top === undefined,
    }

    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      auto = undefined
      autoTimer = undefined
    }, 1500)
  }

  const isAuto = (el: HTMLElement) => {
    const a = auto
    if (!a) return false

    if (Date.now() - a.time > 1500) {
      auto = undefined
      return false
    }

    return Math.abs(el.scrollTop - a.top) < 2
  }

  const scrollToBottomNow = (behavior: ScrollBehavior) => {
    const el = store.scrollRef
    if (!el) return
    markAuto(el)
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior })
      return
    }

    // `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`.
    el.scrollTop = el.scrollHeight
  }

  const scrollToBottom = (force: boolean) => {
    // During the forced-follow window opened by forceScrollToBottom, treat
    // every call as forced so ResizeObserver-driven updates aren't blocked by
    // `userScrolled` (which the user may have set just before sending).
    const forced = force || Date.now() < forceFollowUntil
    if (!forced && !active()) return

    if (forced && store.userScrolled) setStore("userScrolled", false)

    const el = store.scrollRef
    if (!el) return

    if (!forced && store.userScrolled) return

    const distance = distanceFromBottom(el)
    if (distance < 2) {
      markAuto(el)
      return
    }

    // For auto-following content we prefer immediate updates to avoid
    // visible "catch up" animations while content is still settling.
    scrollToBottomNow("auto")
  }

  const stop = () => {
    const el = store.scrollRef
    if (!el) return
    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }
    if (store.userScrolled) return

    setStore("userScrolled", true)
    options.onUserInteracted?.()
  }

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY >= 0) return
    // If the user is scrolling within a nested scrollable region (tool output,
    // code block, etc), don't treat it as leaving the "follow bottom" mode.
    // Those regions opt in via `data-scrollable`.
    const el = store.scrollRef
    const target = e.target instanceof Element ? e.target : undefined
    const nested = target?.closest("[data-scrollable]")
    if (el && nested && nested !== el) return
    stop()
  }

  // Last scrollTop observed on a scroll event. Scroll events only fire when
  // scrollTop actually changes, so comparing consecutive values
  // distinguishes user-driven movement from programmatic/reflow scrolls.
  let prevScrollTop = 0

  const handleScroll = () => {
    const el = store.scrollRef
    if (!el) return

    const top = el.scrollTop
    const max = el.scrollHeight - el.clientHeight
    // Genuine upward movement, excluding two browser-driven cases that must
    // NOT count as the user scrolling away from the bottom:
    //   1. scrollTop clamped down after content above the viewport shrank
    //      (top === max)
    //   2. macOS rubber-band overscroll snapping back at the bottom
    //      (top >= max during the bounce)
    const movedUp = top < prevScrollTop - 1 && top < max - 1
    prevScrollTop = top

    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    if (max - top < threshold()) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    // Keep following when the scroll was ours (isAuto) or the viewport only
    // moved down / stayed put. Previously ANY scroll event that didn't match
    // the last programmatic anchor called stop(), so a single wheel-down tick
    // or a bottom rubber-band bounce during streaming permanently disabled
    // auto-follow: the viewport silently lagged behind the output while
    // staying inside the jump button's reveal threshold, so no affordance
    // to return to the bottom ever appeared.
    if (!store.userScrolled && isAuto(el)) {
      // Only re-follow the bottom when the programmatic scroll being absorbed
      // was itself a bottom scroll. A `bottom: false` mark comes from
      // `markProgrammaticScroll(top)` — e.g. preserveScroll re-anchoring after
      // the turn window shifted — and the viewport must stay exactly where it
      // was placed, otherwise backfill/trimming would yank it to the bottom.
      if (auto?.bottom) scrollToBottom(false)
      return
    }

    if (!store.userScrolled && !movedUp) {
      scrollToBottom(false)
      return
    }

    stop()
  }

  const handleInteraction = () => {
    if (!active()) return
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      stop()
    }
  }

  const updateOverflowAnchor = (el: HTMLElement) => {
    const mode = options.overflowAnchor ?? "dynamic"

    if (mode === "none") {
      el.style.overflowAnchor = "none"
      return
    }

    if (mode === "auto") {
      el.style.overflowAnchor = "auto"
      return
    }

    el.style.overflowAnchor = store.userScrolled ? "auto" : "none"
  }

  createResizeObserver(
    () => store.contentRef,
    () => {
      const el = store.scrollRef
      if (el && !canScroll(el)) {
        if (store.userScrolled) setStore("userScrolled", false)
        return
      }
      if (suspended) return
      if (!active()) return
      if (store.userScrolled) return
      // ResizeObserver fires after layout, before paint.
      // Keep the bottom locked in the same frame to avoid visible
      // "jump up then catch up" artifacts while streaming content.
      scrollToBottom(false)
    },
  )

  createEffect(
    on(options.working, (working: boolean) => {
      settling = false
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined

      if (working) {
        if (!store.userScrolled) scrollToBottom(true)
        return
      }

      settling = true
      settleTimer = setTimeout(() => {
        settling = false
      }, 300)
    }),
  )

  createEffect(() => {
    // Track `userScrolled` even before `scrollRef` is attached, so we can
    // update overflow anchoring once the element exists.
    store.userScrolled
    const el = store.scrollRef
    if (!el) return
    updateOverflowAnchor(el)
  })

  createEventListener(() => store.scrollRef, "wheel", handleWheel, { passive: true })

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (autoTimer) clearTimeout(autoTimer)
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => setStore("scrollRef", el),
    contentRef: (el: HTMLElement | undefined) => setStore("contentRef", el),
    handleScroll,
    handleInteraction,
    pause: stop,
    resume: () => {
      if (store.userScrolled) setStore("userScrolled", false)
      scrollToBottom(true)
    },
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => {
      forceFollowUntil = Date.now() + 500
      scrollToBottom(true)
    },
    userScrolled: () => store.userScrolled,
    // Temporarily suppress the ResizeObserver-driven follow so external
    // code can adjust scrollTop (e.g. preserveScroll during backfill)
    // without the observer fighting it in the same frame.
    suspendFollow: () => {
      suspended = true
    },
    resumeFollow: () => {
      suspended = false
    },
    // Mark the current scroll position as programmatic so the next
    // `handleScroll` invocation recognises it via `isAuto` and does
    // not incorrectly flip `userScrolled` to true.
    markProgrammaticScroll: (top?: number) => {
      const el = store.scrollRef
      if (el) markAuto(el, top)
    },
  }
}
