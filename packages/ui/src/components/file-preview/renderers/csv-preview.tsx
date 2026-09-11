import Papa from "papaparse"
import { createMemo, createSignal, For, Show } from "solid-js"

const PAGE_SIZE = 200
const MAX_ROWS = 100_000

/**
 * CSV preview: streaming-parsed via papaparse, rendered as a paginated table.
 * Large files are capped at MAX_ROWS to keep the DOM bounded.
 */
export function CsvPreview(props: { text: string; errorLabel: string }) {
  const parsed = createMemo(() => {
    try {
      const res = Papa.parse<string[]>(props.text.trim(), { skipEmptyLines: true })
      const data = (res.data as string[][]).slice(0, MAX_ROWS + 1)
      return { data, error: false }
    } catch {
      return { data: [] as string[][], error: true }
    }
  })

  const header = () => parsed().data[0] ?? []
  const body = () => parsed().data.slice(1)
  const [page, setPage] = createSignal(0)
  const totalPages = () => Math.max(1, Math.ceil(body().length / PAGE_SIZE))
  const pageRows = () => body().slice(page() * PAGE_SIZE, page() * PAGE_SIZE + PAGE_SIZE)

  return (
    <Show
      when={!parsed().error}
      fallback={<div class="flex items-center justify-center h-full text-text-weak text-13-regular">{props.errorLabel}</div>}
    >
      <div class="h-full w-full flex flex-col">
        <div class="flex-1 min-h-0 overflow-auto">
          <table class="border-collapse text-12-regular w-max">
            <thead class="sticky top-0 bg-surface-raised-base">
              <tr>
                <th class="border border-border-subtle px-2 py-1 text-text-weak text-right select-none">#</th>
                <For each={header()}>
                  {(cell) => <th class="border border-border-subtle px-2 py-1 text-left text-text-strong">{cell}</th>}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={pageRows()}>
                {(row, i) => (
                  <tr class="hover:bg-surface-raised-base">
                    <td class="border border-border-subtle px-2 py-1 text-text-weak text-right select-none">
                      {page() * PAGE_SIZE + i() + 1}
                    </td>
                    <For each={header()}>
                      {(_, ci) => <td class="border border-border-subtle px-2 py-1 text-text-base">{row[ci()] ?? ""}</td>}
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
