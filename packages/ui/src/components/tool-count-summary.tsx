import { Index, createMemo } from "solid-js"
import { AnimatedCountLabel } from "./tool-count-label"

export type CountItem = {
  key: string
  count: number
  one: string
  other: string
}

export function AnimatedCountList(props: { items?: CountItem[]; fallback?: string; class?: string }) {
  const items = createMemo(() => props.items ?? [])
  // Defensive: ensure items() is always a valid array (guards against SolidJS proxy timing issues)
  const safeItems = createMemo(() => {
    const raw = items()
    return Array.isArray(raw) ? raw : []
  })
  const visible = createMemo(() => safeItems().filter((item) => item?.count > 0))
  const fallback = createMemo(() => props.fallback ?? "")
  const showEmpty = createMemo(() => {
    const v = visible()
    const f = fallback()
    return (v?.length ?? 0) === 0 && (f?.length ?? 0) > 0
  })

  return (
    <span data-component="tool-count-summary" class={props.class}>
      <span data-slot="tool-count-summary-empty" data-active={showEmpty() ? "true" : "false"}>
        <span data-slot="tool-count-summary-empty-inner">{fallback()}</span>
      </span>

      <Index each={safeItems()}>
        {(item, index) => {
          const active = createMemo(() => item()?.count > 0)
          const hasPrev = createMemo(() => {
            const list = safeItems()
            for (let i = index - 1; i >= 0; i--) {
              if (list[i]!.count > 0) return true
            }
            return false
          })

          return (
            <>
              <span data-slot="tool-count-summary-prefix" data-active={active() && hasPrev() ? "true" : "false"}>
                ,
              </span>
              <span data-slot="tool-count-summary-item" data-active={active() ? "true" : "false"}>
                <span data-slot="tool-count-summary-item-inner">
                  <AnimatedCountLabel
                    one={item()?.one}
                    other={item()?.other}
                    count={Math.max(0, Math.round(item()?.count ?? 0))}
                  />
                </span>
              </span>
            </>
          )
        }}
      </Index>
    </span>
  )
}
