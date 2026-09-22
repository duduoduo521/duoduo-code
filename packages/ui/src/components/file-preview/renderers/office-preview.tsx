import { renderAsync } from "docx-preview"
import * as XLSX from "xlsx"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { getFileExtension } from "@duoduo-ai/shared/util/path"

/**
 * Office preview:
 *  - docx/doc → docx-preview renders faithful HTML into a mounted container.
 *  - xls/xlsx → SheetJS parses to rows, rendered as a paginated per-sheet table.
 */
export function OfficePreview(props: { bytes: Uint8Array; path: string; errorLabel: string }) {
  const ext = () => {
    const e = getFileExtension(props.path)
    return e ? e.toLowerCase() : ""
  }
  const isSpreadsheet = () => ext() === "xls" || ext() === "xlsx"
  return (
    <Show when={isSpreadsheet()} fallback={<DocxView bytes={props.bytes} errorLabel={props.errorLabel} />}>
      <XlsxView bytes={props.bytes} errorLabel={props.errorLabel} />
    </Show>
  )
}

function DocxView(props: { bytes: Uint8Array; errorLabel: string }) {
  const [error, setError] = createSignal(false)
  let container!: HTMLDivElement
  onMount(async () => {
    try {
      const blob = new Blob([props.bytes.slice().buffer as ArrayBuffer])
      await renderAsync(blob, container, undefined, {
        className: "docx",
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
      })
    } catch {
      setError(true)
    }
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

const PAGE_SIZE = 200

function XlsxView(props: { bytes: Uint8Array; errorLabel: string }) {
  const workbook = createMemo(() => {
    try {
      return { wb: XLSX.read(props.bytes, { type: "array" }), error: false }
    } catch {
      return { wb: undefined, error: true }
    }
  })

  const sheetNames = () => workbook().wb?.SheetNames ?? []
  const [active, setActive] = createSignal(0)
  const [page, setPage] = createSignal(0)

  const rows = createMemo<string[][]>(() => {
    const wb = workbook().wb
    const name = sheetNames()[active()]
    if (!wb || !name) return []
    const sheet = wb.Sheets[name]
    if (!sheet) return []
    return XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: "" })
  })

  const totalPages = () => Math.max(1, Math.ceil(Math.max(0, rows().length) / PAGE_SIZE))
  const pageRows = () => rows().slice(page() * PAGE_SIZE, page() * PAGE_SIZE + PAGE_SIZE)
  const maxCols = () => rows().reduce((m, r) => Math.max(m, r.length), 0)

  return (
    <Show
      when={!workbook().error}
      fallback={<div class="flex items-center justify-center h-full text-text-weak text-13-regular">{props.errorLabel}</div>}
    >
      <div class="h-full w-full flex flex-col">
        <Show when={sheetNames().length > 1}>
          <div class="flex items-center gap-1 px-2 py-1 border-b border-border-subtle shrink-0 overflow-x-auto">
            <For each={sheetNames()}>
              {(name, i) => (
                <button
                  type="button"
                  class={`px-2 py-0.5 rounded text-12-regular whitespace-nowrap ${active() === i() ? "bg-surface-raised-base text-text-strong" : "text-text-weak"}`}
                  onClick={() => {
                    setActive(i())
                    setPage(0)
                  }}
                >
                  {name}
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="flex-1 min-h-0 overflow-auto">
          <table class="border-collapse text-12-regular w-max">
            <tbody>
              <For each={pageRows()}>
                {(row, i) => (
                  <tr class="hover:bg-surface-raised-base">
                    <td class="border border-border-subtle px-2 py-1 text-text-weak text-right select-none">
                      {page() * PAGE_SIZE + i() + 1}
                    </td>
                    <For each={Array.from({ length: maxCols() })}>
                      {(_, ci) => <td class="border border-border-subtle px-2 py-1 text-text-base">{String(row[ci()] ?? "")}</td>}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={totalPages() > 1}>
          <div class="flex items-center justify-center gap-2 py-1 border-t border-border-subtle shrink-0 text-12-regular">
            <button
              type="button"
              class="px-2 py-0.5 rounded text-text-weak disabled:opacity-40"
              disabled={page() === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              ‹
            </button>
            <span class="text-text-weak">
              {page() + 1} / {totalPages()}
            </span>
            <button
              type="button"
              class="px-2 py-0.5 rounded text-text-weak disabled:opacity-40"
              disabled={page() >= totalPages() - 1}
              onClick={() => setPage((p) => Math.min(totalPages() - 1, p + 1))}
            >
              ›
            </button>
          </div>
        </Show>
      </div>
    </Show>
  )
}
