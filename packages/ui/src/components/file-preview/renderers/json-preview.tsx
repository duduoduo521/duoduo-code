import { createMemo, createSignal, For, Show } from "solid-js"

/**
 * JSON preview: parsed and rendered as a collapsible syntax tree.
 * Falls back to an error notice when the text is not valid JSON.
 */
export function JsonPreview(props: { text: string; errorLabel: string }) {
  const parsed = createMemo<{ value: unknown; error: boolean }>(() => {
    try {
      return { value: JSON.parse(props.text), error: false }
    } catch {
      return { value: undefined, error: true }
    }
  })

  return (
    <Show
      when={!parsed().error}
      fallback={<div class="flex items-center justify-center h-full text-text-weak text-13-regular">{props.errorLabel}</div>}
    >
      <div class="h-full w-full overflow-auto p-3 font-mono text-12-regular leading-relaxed">
        <JsonNode value={parsed().value} name={undefined} depth={0} last />
      </div>
    </Show>
  )
}

function JsonNode(props: { value: unknown; name: string | undefined; depth: number; last: boolean }) {
  const isArray = () => Array.isArray(props.value)
  const isObject = () => props.value !== null && typeof props.value === "object"
  const [open, setOpen] = createSignal(props.depth < 2)

  const entries = createMemo<[string, unknown][]>(() => {
    if (isArray()) return (props.value as unknown[]).map((v, i) => [String(i), v])
    if (isObject()) return Object.entries(props.value as Record<string, unknown>)
    return []
  })

  const keyLabel = () => (props.name !== undefined ? <span class="text-[var(--color-syntax-property,#c586c0)]">"{props.name}": </span> : null)

  return (
    <Show
      when={isObject()}
      fallback={
        <div style={{ "padding-left": `${props.depth * 14}px` }}>
          {keyLabel()}
          <JsonScalar value={props.value} />
          <Show when={!props.last}>,</Show>
        </div>
      }
    >
      <div>
        <div style={{ "padding-left": `${props.depth * 14}px` }} class="cursor-pointer select-none" onClick={() => setOpen((o) => !o)}>
          <span class="text-text-weak inline-block w-3">{open() ? "▾" : "▸"}</span>
          {keyLabel()}
          <span class="text-text-weak">{isArray() ? "[" : "{"}</span>
          <Show when={!open()}>
            <span class="text-text-weak">
              {isArray() ? `${entries().length} items` : `${entries().length} keys`}
              {isArray() ? "]" : "}"}
            </span>
          </Show>
        </div>
        <Show when={open()}>
          <For each={entries()}>
            {([k, v], i) => <JsonNode value={v} name={isArray() ? undefined : k} depth={props.depth + 1} last={i() === entries().length - 1} />}
          </For>
          <div style={{ "padding-left": `${props.depth * 14}px` }} class="text-text-weak">
            {isArray() ? "]" : "}"}
            <Show when={!props.last}>,</Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function JsonScalar(props: { value: unknown }) {
  const v = props.value
  if (typeof v === "string") return <span class="text-[var(--color-syntax-string,#ce9178)]">"{v}"</span>
  if (typeof v === "number") return <span class="text-[var(--color-syntax-number,#b5cea8)]">{v}</span>
  if (typeof v === "boolean") return <span class="text-[var(--color-syntax-keyword,#569cd6)]">{String(v)}</span>
  if (v === null) return <span class="text-text-weak">null</span>
  // Fallback for any non-primitive (should not occur for JSON scalars); JSON.stringify
  // is safe for objects/arrays and avoids "[object Object]" from String().
  return <span>{JSON.stringify(v)}</span>
}
