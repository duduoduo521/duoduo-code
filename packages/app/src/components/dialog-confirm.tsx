import { Show, type JSXElement } from "solid-js"
import { Button } from "@duoduo-ai/ui/button"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Icon } from "@duoduo-ai/ui/icon"
import { useLanguage } from "@/context/language"

/**
 * Shared confirmation dialog used by EVERY confirm prompt in the app
 * (delete file / session / workspace / model / gear / memory, clear index,
 * clear memories, …). One component so layout, typography, spacing and
 * button semantics stay identical everywhere.
 *
 *  · `danger` renders a critical warning icon and a critical confirm button
 *    (destructive actions must never share the ordinary primary styling).
 *  · `detail` is the secondary line (file preview, dirty state, …).
 *  · `busy` disables both the confirm button and shows the loading ellipsis.
 *  · `onCancel` is also wired to the header close (X) button.
 */
export function DialogConfirm(props: {
  title: string
  message: string | JSXElement
  detail?: string | JSXElement
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  confirmDisabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const language = useLanguage()
  return (
    <Dialog title={props.title} fit closeAction={props.onCancel}>
      <div class="flex flex-col gap-5 px-[var(--dialog-gutter)] pb-5 pt-5">
        <div
          class="flex gap-3"
          classList={{
            "items-center": !props.detail,
            "items-start": !!props.detail,
          }}
        >
          <Show when={props.danger}>
            <Icon name="circle-alert" class="size-5 shrink-0 text-icon-critical-base" />
          </Show>
          <div class="flex min-w-0 flex-col gap-1">
            <p class="text-14-medium text-text-strong">{props.message}</p>
            <Show when={props.detail}>
              {/* div, not p: callers may pass block-level JSX (lists) as detail */}
              <div class="text-13-regular text-text-weak break-words">{props.detail}</div>
            </Show>
          </div>
        </div>
        <div class="flex items-center justify-end gap-2">
          <Button variant="ghost" size="large" onClick={props.onCancel}>
            {props.cancelLabel ?? language.t("common.cancel")}
          </Button>
          <Button
            variant={props.danger ? "critical" : "primary"}
            size="large"
            disabled={props.busy || props.confirmDisabled}
            onClick={props.onConfirm}
          >
            {props.busy
              ? language.t("common.loading.ellipsis")
              : (props.confirmLabel ?? language.t("common.confirm"))}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
