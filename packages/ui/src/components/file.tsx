import { DiffViewer as DiffEngineViewer } from "../diff-engine/DiffViewer"
import { FileViewer as FileEngineViewer } from "../diff-engine/FileViewer"
import { type LineSelection } from "../diff-engine/selection"
import { type DiffLineAnnotation, type LineAnnotation, type FileContents, type FileOptions } from "../diff-engine/types"
import { createMediaQuery } from "@solid-primitives/media"
import { ComponentProps, splitProps } from "solid-js"
import { styleVariables } from "../pierre"
import { FileMedia, type FileMediaOptions } from "./file-media"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SharedProps<T> = {
  annotations?: LineAnnotation<T>[] | DiffLineAnnotation<T>[]
  selectedLines?: LineSelection | null
  commentedLines?: LineSelection[]
  onLineSelected?: (range: LineSelection | null) => void
  onLineSelectionEnd?: (range: LineSelection | null) => void
  onLineNumberSelectionEnd?: (selection: LineSelection | null) => void
  onRendered?: () => void
  class?: string
  classList?: ComponentProps<"div">["classList"]
  media?: FileMediaOptions
}

export type TextFileProps<T = {}> = FileOptions<T> &
  SharedProps<T> & {
    mode: "text"
    file: FileContents
    annotations?: LineAnnotation<T>[]
  }

type DiffBaseProps<T> = SharedProps<T> & {
  mode: "diff"
  annotations?: DiffLineAnnotation<T>[]
  diffStyle?: "unified" | "split"
  enableLineSelection?: boolean
}

type DiffPairProps<T> = DiffBaseProps<T> & {
  before: FileContents
  after: FileContents
}

export type DiffFileProps<T = {}> = DiffPairProps<T>

export type FileProps<T = {}> = TextFileProps<T> | DiffFileProps<T>

// ---------------------------------------------------------------------------
// TextViewer — delegates to FileEngineViewer (plain DOM, no Shadow DOM)
// ---------------------------------------------------------------------------

function TextViewer<T>(props: TextFileProps<T>) {
  const [local] = splitProps(props, [
    "mode",
    "file",
    "annotations",
    "selectedLines",
    "commentedLines",
    "onLineSelected",
    "onLineSelectionEnd",
    "onLineNumberSelectionEnd",
    "onRendered",
    "class",
    "classList",
    "media",
  ])

  const contents = () => {
    const value = local.file.contents as unknown
    if (typeof value === "string") return value
    if (Array.isArray(value)) return value.join("\n")
    if (value == null) return ""
    // oxlint-disable-next-line no-base-to-string -- final fallback stringification for display
    return String(value)
  }

  const lang = () => local.file.lang ?? "text"

  return (
    <div
      data-component="file"
      data-mode="text"
      style={styleVariables}
      class="relative outline-none"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <FileEngineViewer
        contents={contents()}
        lang={lang()}
        name={local.file.name}
        selectedLines={local.selectedLines}
        commentedLines={local.commentedLines}
        enableLineSelection={false}
        onLineSelected={local.onLineSelected}
        onLineSelectionEnd={local.onLineSelectionEnd}
        onLineNumberSelectionEnd={local.onLineNumberSelectionEnd}
        onRendered={local.onRendered}
        annotations={local.annotations as LineAnnotation<unknown>[] | undefined}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// DiffViewer — delegates to DiffEngineViewer (plain DOM, no Shadow DOM)
// ---------------------------------------------------------------------------

function DiffViewer<T>(props: DiffFileProps<T>) {
  const [local] = splitProps(props, [
    "mode",
    "before",
    "after",
    "diffStyle",
    "enableLineSelection",
    "annotations",
    "selectedLines",
    "commentedLines",
    "onLineSelected",
    "onLineSelectionEnd",
    "onLineNumberSelectionEnd",
    "onRendered",
    "class",
    "classList",
    "media",
  ])

  const mobile = createMediaQuery("(max-width: 640px)")

  const beforeContents = () => (typeof local.before?.contents === "string" ? local.before.contents : "")
  const afterContents = () => (typeof local.after?.contents === "string" ? local.after.contents : "")
  const lang = () => local.before?.lang ?? local.after?.lang ?? "text"

  return (
    <div
      data-component="file"
      data-mode="diff"
      style={styleVariables}
      class="relative outline-none"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <DiffEngineViewer
        before={beforeContents()}
        after={afterContents()}
        lang={lang()}
        disableLineNumbers={mobile()}
        wordDiff={local.diffStyle !== "split"}
        enableLineSelection={local.enableLineSelection === true}
        selectedLines={local.selectedLines}
        commentedLines={local.commentedLines}
        onLineSelected={local.onLineSelected}
        onLineSelectionEnd={local.onLineSelectionEnd}
        onLineNumberSelectionEnd={local.onLineNumberSelectionEnd}
        onRendered={local.onRendered}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function File<T>(props: FileProps<T>) {
  if (props.mode === "text") {
    return <FileMedia media={props.media} fallback={() => TextViewer(props)} />
  }

  return <FileMedia media={props.media} fallback={() => DiffViewer(props)} />
}
