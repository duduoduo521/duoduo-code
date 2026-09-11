import { createEffect } from "solid-js"

type Input = {
  prevScrollWidth: number
  scrollWidth: number
  clientWidth: number
  prevContextOpen: boolean
  contextOpen: boolean
}

export const nextTabListScrollLeft = (input: Input) => {
  if (input.scrollWidth <= input.prevScrollWidth) return
  if (!input.prevContextOpen && input.contextOpen) return 0
  if (input.scrollWidth <= input.clientWidth) return
  return input.scrollWidth - input.clientWidth
}

/**
 * Selector for the trailing "add file" (+) button inside the tab list.
 * It is sticky-positioned over the scroll viewport, so the active tab must
 * never be scrolled underneath it.
 */
const ADD_BUTTON_SELECTOR = ".file-tab-add"

/**
 * Scroll the currently selected tab into view, leaving room for the sticky
 * "+" button so it is never hidden behind it. No-op when the tab list is not
 * horizontally scrollable (e.g. when tab wrapping is enabled).
 */
const scrollActiveTabIntoView = (el: HTMLDivElement) => {
  const selected = el.querySelector<HTMLElement>("[data-selected]")
  const wrapper = selected?.closest<HTMLElement>('[data-slot="tabs-trigger-wrapper"]')
  if (!wrapper) return

  const button = el.querySelector<HTMLElement>(ADD_BUTTON_SELECTOR)
  const buttonWidth = button ? button.offsetWidth : 0

  // Use viewport-relative rects rather than `offsetLeft`, because the trigger
  // is wrapped by positioned ancestors (e.g. the `position: relative` div in
  // SortableTab), which would otherwise become the `offsetParent` and make
  // `offsetLeft` relative to that local wrapper instead of the scroll
  // container `el` — breaking the scroll math entirely.
  const elRect = el.getBoundingClientRect()
  const wrapRect = wrapper.getBoundingClientRect()
  const elLeft = wrapRect.left - elRect.left + el.scrollLeft
  const elRight = elLeft + wrapRect.width
  const visibleLeft = el.scrollLeft
  const visibleRight = el.scrollLeft + el.clientWidth - buttonWidth

  if (elRight > visibleRight) {
    el.scrollTo({ left: elRight - el.clientWidth + buttonWidth, behavior: "smooth" })
  } else if (elLeft < visibleLeft) {
    el.scrollTo({ left: elLeft, behavior: "smooth" })
  }
}

export const createFileTabListSync = (input: {
  el: HTMLDivElement
  contextOpen: () => boolean
  /** Optional. When provided, switching tabs triggers a scroll-to-visible.
   *  The active tab is always located from the DOM ([data-selected]) as a
   *  fallback, so callers that don't pass it still work. */
  activeTab?: () => string
}) => {
  let frame: number | undefined
  let prevContextOpen = input.contextOpen()
  let prevActiveTab = input.activeTab?.()

  const schedule = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      scrollActiveTabIntoView(input.el)
    })
  }

  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    input.el.scrollLeft += e.deltaY > 0 ? 50 : -50
    e.preventDefault()
  }

  input.el.addEventListener("wheel", onWheel, { passive: false })
  const observer = new MutationObserver(schedule)
  observer.observe(input.el, { childList: true })

  // Keep the active tab visible when the selection changes (e.g. switching tabs
  // without adding/removing any), not just when the DOM mutates. Only active
  // when a reactive activeTab getter is supplied; otherwise the MutationObserver
  // plus the [data-selected] lookup already keep it visible.
  if (input.activeTab) {
    createEffect(() => {
      const tab = input.activeTab!()
      if (tab !== prevActiveTab) {
        prevActiveTab = tab
        schedule()
      }
    })
  }

  return () => {
    input.el.removeEventListener("wheel", onWheel)
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}
