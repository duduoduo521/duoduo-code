import { Show } from "solid-js"

/**
 * Inline image/SVG preview for the workspace file preview panel.
 * SVG is rendered via <object> to preserve interactivity; raster images via <img>.
 */
export function ImagePreviewInline(props: { url: string; mimeType?: string; alt?: string }) {
  const isSvg = () => props.mimeType === "image/svg+xml" || (props.mimeType?.includes("svg") ?? false)
  return (
    <div class="h-full w-full overflow-auto flex items-center justify-center bg-surface-base p-4">
      <Show
        when={isSvg()}
        fallback={<img src={props.url} alt={props.alt ?? ""} class="max-w-full max-h-full object-contain" />}
      >
        <object data={props.url} type="image/svg+xml" class="max-w-full max-h-full w-full h-full" />
      </Show>
    </div>
  )
}
