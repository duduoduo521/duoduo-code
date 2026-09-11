import { Component, For, Show } from "solid-js"
import { Icon } from "@duoduo-ai/ui/icon"
import { Tooltip } from "@duoduo-ai/ui/tooltip"
import type { TextFileAttachmentPart } from "@/context/prompt"

type PromptTextFileAttachmentsProps = {
  attachments: TextFileAttachmentPart[]
  onRemove: (id: string) => void
  removeLabel: string
}

export const PromptTextFileAttachments: Component<PromptTextFileAttachmentsProps> = (props) => {
  return (
    <Show when={props.attachments.length > 0}>
      <div class="flex flex-wrap gap-2 px-3 pt-3">
        <For each={props.attachments}>
          {(attachment) => (
            <Tooltip value={attachment.filename} placement="top" contentClass="break-all">
              <div class="relative group flex items-center gap-1.5 bg-surface-elevated rounded-md px-2 py-1 border border-border">
                <Icon name="file-tree" class="size-4 text-text-weak" />
                <span class="text-12-regular text-text truncate max-w-32">{attachment.filename}</span>
                <span class="text-10-regular text-text-weak">{formatSize(attachment.text.length)}</span>
                <button
                  type="button"
                  onClick={() => props.onRemove(attachment.id)}
                  class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
                  aria-label={props.removeLabel}
                >
                  <Icon name="close" class="size-2.5" />
                </button>
              </div>
            </Tooltip>
          )}
        </For>
      </div>
    </Show>
  )
}

function formatSize(chars: number) {
  if (chars < 1024) return `${chars} chars`
  return `${(chars / 1024).toFixed(1)} KB`
}
