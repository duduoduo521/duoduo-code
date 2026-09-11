import { createMemo, createSignal, onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { ResizeHandle } from "@duoduo-ai/ui/resize-handle"
import { useLayout } from "@/context/layout"
import { createSizing } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"

export function PreviewPanel() {
  const layout = useLayout()
  const { view } = useSessionLayout()

  const opened = createMemo(() => view().preview.opened())
  const url = createMemo(() => view().preview.url())
  const height = createMemo(() => layout.preview.height())
  const close = () => view().preview.close()

  const size = createSizing()
  const [viewport, setViewport] = createSignal<"desktop" | "mobile">("desktop")
  const [viewHeight, setViewHeight] = createSignal(typeof window !== "undefined" ? window.innerHeight : 1000)

  onMount(() => {
    if (typeof window === "undefined") return

    const sync = () => setViewHeight(window.visualViewport?.height ?? window.innerHeight)
    const port = window.visualViewport

    sync()
    makeEventListener(window, "resize", sync)
    if (port) makeEventListener(port, "resize", sync)
  })

  const max = () => viewHeight() * 0.6
  const pane = () => Math.min(height(), max())

  let inputRef: HTMLInputElement | undefined
  let iframeRef: HTMLIFrameElement | undefined

  const handleOpen = () => {
    const val = inputRef?.value
    if (val) {
      // Local dev servers are served over plain http; defaulting them to
      // https:// would miss the frame-src allowlist (localhost-only http).
      const isLocal = /^localhost([:/]|$)/.test(val) || /^127\.0\.0\.1([:/]|$)/.test(val)
      const scheme = val.startsWith("http") ? "" : isLocal ? "http://" : "https://"
      view().preview.open(scheme + val)
    }
  }

  const handleRefresh = () => {
    const currentUrl = iframeRef?.src
    if (currentUrl) {
      iframeRef.src = "about:blank"
      setTimeout(() => {
        if (iframeRef) iframeRef.src = currentUrl
      }, 0)
    }
  }

  return (
    <div
      id="preview-panel"
      data-component="preview-panel"
      role="region"
      aria-label="Preview Panel"
      aria-hidden={!opened()}
      inert={!opened()}
      class="relative w-full shrink-0 overflow-hidden bg-background-stronger"
      classList={{
        "border-t border-border-weak-base": opened(),
        "transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[height] motion-reduce:transition-none":
          !size.active(),
      }}
      style={{ height: opened() ? `${pane()}px` : "0px" }}
    >
      <div
        class="absolute inset-x-0 top-0 flex flex-col"
        classList={{
          "pointer-events-none": !opened(),
        }}
        style={{ height: `${pane()}px` }}
      >
        <div class="hidden md:block" onPointerDown={() => size.start()}>
          <ResizeHandle
            direction="vertical"
            size={pane()}
            min={100}
            max={max()}
            collapseThreshold={50}
            onResize={(next) => {
              size.touch()
              layout.preview.resize(next)
            }}
            onCollapse={close}
          />
        </div>
        <div class="flex items-center gap-2 px-3 py-2 border-b border-border-weaker-base bg-background">
          <input
            ref={inputRef}
            type="text"
            value={url() ?? ""}
            onInput={(e) => {
              /* URL is controlled by preview.open() */
            }}
            onKeyDown={(e) => e.key === "Enter" && handleOpen()}
            class="flex-1 text-sm bg-background border border-border-weaker-base rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-border-focus"
            placeholder="Enter URL..."
          />
          <button onClick={handleRefresh} class="px-2 py-1 text-sm hover:bg-surface-base rounded" aria-label="Refresh">
            ↻
          </button>
          <button
            onClick={() => setViewport((v) => (v === "desktop" ? "mobile" : "desktop"))}
            class="px-2 py-1 text-sm hover:bg-surface-base rounded"
            aria-label={viewport() === "desktop" ? "Switch to mobile view" : "Switch to desktop view"}
          >
            {viewport() === "desktop" ? "📱" : "🖥️"}
          </button>
          <button onClick={close} class="px-2 py-1 text-sm hover:bg-surface-base rounded" aria-label="Close preview">
            ✕
          </button>
        </div>
        <div class="flex-1 overflow-hidden bg-background-stronger">
          {url() && (
            <iframe
              ref={iframeRef}
              src={url()!}
              sandbox="allow-scripts allow-same-origin allow-forms"
              class="w-full h-full border-0"
              style={{
                "max-width": viewport() === "mobile" ? "375px" : "100%",
                margin: viewport() === "mobile" ? "0 auto" : "0",
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
