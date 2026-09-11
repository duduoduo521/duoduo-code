import { createEffect, onCleanup, onMount, splitProps } from "solid-js"
import { styleVariables } from "../pierre"
import { DiffViewer, type DiffViewerProps } from "../diff-engine/DiffViewer"
import { type LineSelection } from "../diff-engine/selection"
import { File, type FileProps } from "./file"

type SSRDiffFileProps = DiffViewerProps & {
  preloadedDiff?: unknown
}

function DiffSSRViewer<T>(props: SSRDiffFileProps) {
  const [local, others] = splitProps(props, ["class", "classList"])

  // DiffEngineViewer renders directly to DOM — no Shadow DOM hydration needed.
  // For SSR, the server renders the same component; the client hydrates naturally.
  return (
    <div data-component="file" data-mode="diff" style={styleVariables} class={local.class} classList={local.classList}>
      <DiffViewer {...others} />
    </div>
  )
}

export type FileSSRProps<T = {}> = FileProps<T>

export function FileSSR<T>(props: FileSSRProps<T>) {
  if (props.mode !== "diff") return File(props)
  return DiffSSRViewer(props as unknown as SSRDiffFileProps)
}
