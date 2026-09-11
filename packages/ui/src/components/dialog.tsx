import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { ComponentProps, JSXElement, ParentProps, Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

export interface DialogProps extends ParentProps {
  title?: JSXElement
  description?: JSXElement
  action?: JSXElement
  footer?: JSXElement
  size?: "normal" | "large" | "x-large"
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  fit?: boolean
  transition?: boolean
  /** When provided, the close (X) button calls this instead of closing the dialog. */
  closeAction?: () => void
}

export function Dialog(props: DialogProps) {
  const i18n = useI18n()
  return (
    <div
      data-component="dialog"
      data-fit={props.fit ? true : undefined}
      data-size={props.size || "normal"}
      // Transitions are on by default so closing always plays a smooth fade-out
      // (instead of the whole dialog disappearing in one frame, which reads as
      // the UI "freezing"). Opt out explicitly with `transition={false}`.
      data-transition={props.transition === false ? undefined : true}
    >
      <div data-slot="dialog-container">
        <Kobalte.Content
          data-slot="dialog-content"
          data-no-header={!props.title && !props.action ? "" : undefined}
          classList={{
            ...props.classList,
            [props.class ?? ""]: !!props.class,
          }}
          onOpenAutoFocus={(e) => {
            const target = e.currentTarget as HTMLElement | null
            const autofocusEl = target?.querySelector("[autofocus]") as HTMLElement | null
            if (autofocusEl) {
              e.preventDefault()
              // onOpenAutoFocus runs synchronously inside FocusScope's mount
              // effect, BEFORE the previous top layer's focus-scope listeners
              // have been torn down (that happens a microtask later). Focusing
              // synchronously inside that window lets the dying scope and the
              // new scope fight over focus — on WKWebView (Safari engine) the
              // deferred focusin dispatch makes the two scopes pull focus back
              // and forth in one synchronous chain until the stack overflows
              // (RangeError: Maximum call stack size exceeded). Deferring by
              // one microtask lets every focus scope settle first.
              queueMicrotask(() => autofocusEl.focus())
            }
          }}
          onInteractOutside={(e) => e.preventDefault()}
        >
          {/* Dialogs that supply a title and/or an action render a normal
              header bar (title on the left, action + closable button on the
              right). Dialogs with neither (e.g. the tabbed Settings dialog)
              get ONLY a floating close button in the top-right corner, so they
              stay closable without an empty white title bar. */}
          <Show when={props.title || props.action}>
            <div data-slot="dialog-header">
              <Show when={props.title}>
                <Kobalte.Title data-slot="dialog-title">{props.title}</Kobalte.Title>
              </Show>
              <div class="flex items-center gap-2" data-slot="dialog-actions">
                {props.action}
                <Show
                  when={props.closeAction}
                  fallback={
                    <Kobalte.CloseButton
                      data-slot="dialog-close-button"
                      as={IconButton}
                      icon="close"
                      variant="ghost"
                      aria-label={i18n.t("ui.common.close")}
                    />
                  }
                >
                  <IconButton
                    data-slot="dialog-close-button"
                    icon="close"
                    variant="ghost"
                    aria-label={i18n.t("ui.common.close")}
                    onClick={props.closeAction}
                  />
                </Show>
              </div>
            </div>
          </Show>
          <Show when={!props.title && !props.action}>
            <div class="command-palette-dialog-close-row">
              <Show
                when={props.closeAction}
                fallback={
                  <Kobalte.CloseButton
                    data-slot="dialog-close-floating"
                    as={IconButton}
                    icon="close"
                    variant="ghost"
                    aria-label={i18n.t("ui.common.close")}
                  />
                }
              >
                <IconButton
                  data-slot="dialog-close-floating"
                  icon="close"
                  variant="ghost"
                  aria-label={i18n.t("ui.common.close")}
                  onClick={props.closeAction}
                />
              </Show>
            </div>
          </Show>
          <Show when={props.description}>
            <Kobalte.Description data-slot="dialog-description">
              {props.description}
            </Kobalte.Description>
          </Show>
          <div data-slot="dialog-body">{props.children}</div>
          <Show when={props.footer}>
            <div data-slot="dialog-footer">{props.footer}</div>
          </Show>
        </Kobalte.Content>
      </div>
    </div>
  )
}
