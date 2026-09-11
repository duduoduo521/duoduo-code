import { Show, type JSXElement } from "solid-js"

/**
 * Shared page shell for ALL settings tabs — every tab renders through this so
 * the whole Settings dialog uses exactly one set of layout / scrolling /
 * header styles; tabs differ only in their content.
 *
 * Structure (extracted from the 通用 tab, which is the design baseline):
 *  · scroll container: `h-full min-h-0 overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10`
 *  · sticky gradient top bar (content scrolls under the title)
 *  · `h2` title (text-16-medium text-text-strong) + optional 13px description
 *  · optional `actions` (right side of the title row) and `toolbar`
 *    (full-width row under the title, e.g. a search field) — both stay pinned
 *    inside the sticky bar
 *  · content region: vertical stack with the shared section gap
 */
export function SettingsPage(props: {
  title: string
  description?: string
  actions?: JSXElement
  toolbar?: JSXElement
  children: JSXElement
}) {
  return (
    <div class="flex flex-col h-full min-h-0 overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-6">
          <div class="flex flex-col gap-1">
            <div class="flex items-center justify-between gap-4">
              <h2 class="text-16-medium text-text-strong">{props.title}</h2>
              {props.actions}
            </div>
            <Show when={props.description}>
              <p class="text-13-regular text-text-weak">{props.description}</p>
            </Show>
          </div>
          {props.toolbar}
        </div>
      </div>
      <div class="flex flex-col gap-8">{props.children}</div>
    </div>
  )
}
