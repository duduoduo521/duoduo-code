import type { FileContent } from "@duoduo-ai/sdk/v2"
import { base64ToBytes } from "@duoduo-ai/shared/util/encode"
import { getCapability } from "@duoduo-ai/shared/util/preview-capability"
import { createEffect, createMemo, createResource, createSignal, Match, onCleanup, Show, Switch } from "solid-js"
import { CsvPreview } from "./file-preview/renderers/csv-preview"
import { ImagePreviewInline } from "./file-preview/renderers/image-preview-inline"
import { JsonPreview } from "./file-preview/renderers/json-preview"
import { OfficePreview } from "./file-preview/renderers/office-preview"
import { PdfPreview } from "./file-preview/renderers/pdf-preview"

export interface FilePreviewProps {
  path: string
  /**
   * Byte reader supplied by the app layer (wraps sdk.client.file.read). The ui
   * package stays free of any sdk dependency; bytes never touch the file store.
   */
  read: (path: string) => Promise<FileContent | undefined>
  loadingLabel: string
  errorLabel: string
  unsupportedLabel: string
}

/**
 * Unified preview surface. Dispatches to a renderer by file capability
 * (shared/preview-capability). Preview bytes are self-managed here (ObjectURL
 * created/revoked locally) and never enter the editable-text channel.
 */
export function FilePreview(props: FilePreviewProps) {
  const cap = createMemo(() => getCapability(props.path))

  const [content] = createResource(
    () => props.path,
    (p) => props.read(p),
  )

  // Raw bytes for binary payloads (base64-encoded from the backend).
  const bytes = createMemo(() => {
    const c = content()
    if (!c || c.encoding !== "base64" || !c.content) return undefined
    try {
      return base64ToBytes(c.content)
    } catch {
      return undefined
    }
  })

  // ObjectURL for image/svg rendering; created and revoked with the content.
  const [blobUrl, setBlobUrl] = createSignal<string | undefined>(undefined)
  createEffect(() => {
    const b = bytes()
    const c = content()
    if (!b || !c) {
      setBlobUrl(undefined)
      return
    }
    const url = URL.createObjectURL(new Blob([b.slice().buffer as ArrayBuffer], { type: c.mimeType }))
    setBlobUrl(url)
    onCleanup(() => URL.revokeObjectURL(url))
  })

  const ready = () => !content.loading && !content.error && !!content()

  return (
    <Switch>
      <Match when={content.loading}>
        <Centered>{props.loadingLabel}</Centered>
      </Match>
      <Match when={content.error || !content()}>
        <Centered>{props.errorLabel}</Centered>
      </Match>
      <Match when={ready() && cap()?.kind === "image"}>
        <Show when={blobUrl()} fallback={<Centered>{props.loadingLabel}</Centered>}>
          {(url) => <ImagePreviewInline url={url()} mimeType={content()?.mimeType} alt={props.path} />}
        </Show>
      </Match>
      <Match when={ready() && cap()?.kind === "csv"}>
        <CsvPreview text={content()!.content} errorLabel={props.errorLabel} />
      </Match>
      <Match when={ready() && cap()?.kind === "json"}>
        <JsonPreview text={content()!.content} errorLabel={props.errorLabel} />
      </Match>
      <Match when={ready() && cap()?.kind === "pdf"}>
        <Show when={bytes()} fallback={<Centered>{props.errorLabel}</Centered>}>
          {(b) => <PdfPreview bytes={b()} errorLabel={props.errorLabel} />}
        </Show>
      </Match>
      <Match when={ready() && cap()?.kind === "office"}>
        <Show when={bytes()} fallback={<Centered>{props.errorLabel}</Centered>}>
          {(b) => <OfficePreview bytes={b()} path={props.path} errorLabel={props.errorLabel} />}
        </Show>
      </Match>
      <Match when={true}>
        <Centered>{props.unsupportedLabel}</Centered>
      </Match>
    </Switch>
  )
}

function Centered(props: { children: unknown }) {
  return (
    <div class="flex items-center justify-center h-full w-full px-6 py-4 text-text-weak text-13-regular">
      {props.children as never}
    </div>
  )
}
