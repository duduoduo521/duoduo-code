import { type ComponentProps, splitProps, Show } from "solid-js"

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined

function first(value: string) {
  if (!value) return ""
  if (!segmenter) return Array.from(value)[0] ?? ""
  return segmenter.segment(value)[Symbol.iterator]().next().value?.segment ?? Array.from(value)[0] ?? ""
}

export interface AvatarProps extends ComponentProps<"div"> {
  fallback: string
  src?: string
  alt?: string
  background?: string
  foreground?: string
  size?: "small" | "normal" | "large"
}

export function Avatar(props: AvatarProps) {
  const [split, rest] = splitProps(props, [
    "fallback",
    "src",
    "alt",
    "background",
    "foreground",
    "size",
    "class",
    "classList",
    "style",
  ])
  const src = split.src // did this so i can zero it out to test fallback
  // An explicitly provided background (e.g. a user-chosen project color) must
  // win over the transparent background used for custom icon images, otherwise
  // the color is clipped away whenever an avatar has any `src`.
  const hasOwnBackground = !!split.background
  return (
    <div
      {...rest}
      data-component="avatar"
      data-size={split.size || "normal"}
      data-has-image={src && !hasOwnBackground ? "" : undefined}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      style={{
        ...(typeof split.style === "object" ? split.style : {}),
        ...(split.background ? { "--avatar-bg": split.background } : {}),
        ...(split.foreground ? { "--avatar-fg": split.foreground } : {}),
      }}
    >
      <Show when={src} fallback={first(split.fallback)}>
        {(src) => <img src={src()} alt={split.alt ?? ""} draggable={false} data-slot="avatar-image" />}
      </Show>
    </div>
  )
}
