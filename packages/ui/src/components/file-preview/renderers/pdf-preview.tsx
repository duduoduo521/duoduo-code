import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist"
// Vite bundles the ES-module worker via ?url; Tauri webview loads it as a local
// resource (CSP is not enabled in this project, so blob/url workers pass freely).
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import { createSignal, onCleanup, onMount, Show } from "solid-js"

GlobalWorkerOptions.workerSrc = workerUrl

// cMaps + standard fonts are copied into app/public/pdfjs at prepare time so
// CJK / special fonts render correctly and work offline inside Tauri.
const CMAP_URL = "/pdfjs/cmaps/"
const STANDARD_FONT_URL = "/pdfjs/standard_fonts/"

/**
 * PDF preview: pdf.js renders page-by-page (first page eagerly for a <1s first
 * paint, remaining pages lazily via IntersectionObserver).
 */
export function PdfPreview(props: { bytes: Uint8Array; errorLabel: string }) {
  const [error, setError] = createSignal(false)
  let container!: HTMLDivElement
  let doc: PDFDocumentProxy | undefined
  let task: PDFDocumentLoadingTask | undefined
  let observer: IntersectionObserver | undefined

  const renderPage = async (pageNum: number, canvas: HTMLCanvasElement) => {
    if (!doc || canvas.dataset.rendered === "1") return
    canvas.dataset.rendered = "1"
    const page = await doc.getPage(pageNum)
    const viewport = page.getViewport({ scale: 1.5 })
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    canvas.width = viewport.width
    canvas.height = viewport.height
    canvas.style.width = "100%"
    canvas.style.height = "auto"
    await page.render({ canvas, canvasContext: ctx, viewport }).promise
  }

  onMount(async () => {
    try {
      // pdf.js may detach the buffer; hand it a private copy.
      const data = props.bytes.slice()
      const loadTask = getDocument({ data, cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: STANDARD_FONT_URL })
      task = loadTask
      doc = await loadTask.promise
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            const canvas = entry.target as HTMLCanvasElement
            const num = Number(canvas.dataset.page)
            void renderPage(num, canvas)
            observer?.unobserve(canvas)
          }
        },
        { root: container, rootMargin: "300px" },
      )
      for (let i = 1; i <= doc.numPages; i++) {
        const canvas = document.createElement("canvas")
        canvas.dataset.page = String(i)
        canvas.className = "block mx-auto my-2 shadow-sm bg-white max-w-full"
        container.appendChild(canvas)
        if (i === 1) void renderPage(1, canvas)
        else observer.observe(canvas)
      }
    } catch {
      setError(true)
    }
  })

  onCleanup(() => {
    observer?.disconnect()
    void task?.destroy()
  })

  return (
    <Show
      when={!error()}
      fallback={<div class="flex items-center justify-center h-full text-text-weak text-13-regular">{props.errorLabel}</div>}
    >
      <div ref={container} class="h-full w-full overflow-auto bg-surface-base p-2" />
    </Show>
  )
}
