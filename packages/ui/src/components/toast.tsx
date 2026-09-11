import { Toast as Kobalte, toaster } from "@kobalte/core/toast"
import type { ToastRootProps, ToastCloseButtonProps, ToastTitleProps, ToastDescriptionProps } from "@kobalte/core/toast"
import type { ComponentProps, JSX } from "solid-js"
import { createSignal, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useI18n } from "../context/i18n"
import { Icon, type IconProps } from "./icon"
import { IconButton } from "./icon-button"
import { copyToClipboard } from "../utils/clipboard"

export interface ToastRegionProps extends ComponentProps<typeof Kobalte.Region> {}

function ToastRegion(props: ToastRegionProps) {
  return (
    <Portal>
      <Kobalte.Region data-component="toast-region" {...props}>
        <Kobalte.List data-slot="toast-list" />
      </Kobalte.Region>
    </Portal>
  )
}

export interface ToastRootComponentProps extends ToastRootProps {
  class?: string
  classList?: ComponentProps<"li">["classList"]
  children?: JSX.Element
}

function ToastRoot(props: ToastRootComponentProps) {
  return (
    <Kobalte
      data-component="toast"
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
      {...props}
    />
  )
}

function ToastIcon(props: { name: IconProps["name"] }) {
  return (
    <div data-slot="toast-icon">
      <Icon name={props.name} />
    </div>
  )
}

function ToastContent(props: ComponentProps<"div">) {
  return <div data-slot="toast-content" {...props} />
}

function ToastTitle(props: ToastTitleProps & ComponentProps<"div">) {
  return <Kobalte.Title data-slot="toast-title" {...props} />
}

function ToastDescription(props: ToastDescriptionProps & ComponentProps<"div">) {
  return <Kobalte.Description data-slot="toast-description" {...props} />
}

function ToastActions(props: ComponentProps<"div">) {
  return <div data-slot="toast-actions" {...props} />
}

function ToastCloseButton(props: ToastCloseButtonProps & ComponentProps<"button">) {
  const i18n = useI18n()
  return (
    <Kobalte.CloseButton
      data-slot="toast-close-button"
      as={IconButton}
      icon="close"
      variant="ghost"
      aria-label={i18n.t("ui.common.dismiss")}
      {...props}
    />
  )
}

function ToastProgressTrack(props: ComponentProps<typeof Kobalte.ProgressTrack>) {
  return <Kobalte.ProgressTrack data-slot="toast-progress-track" {...props} />
}

function ToastProgressFill(props: ComponentProps<typeof Kobalte.ProgressFill>) {
  return <Kobalte.ProgressFill data-slot="toast-progress-fill" {...props} />
}

export const Toast = Object.assign(ToastRoot, {
  Region: ToastRegion,
  Icon: ToastIcon,
  Content: ToastContent,
  Title: ToastTitle,
  Description: ToastDescription,
  Actions: ToastActions,
  CloseButton: ToastCloseButton,
  ProgressTrack: ToastProgressTrack,
  ProgressFill: ToastProgressFill,
})

export { toaster }

export type ToastVariant = "default" | "success" | "error" | "loading"

export interface ToastAction {
  label: string
  onClick: "dismiss" | (() => void)
}

export interface ToastOptions {
  title?: string
  description?: string
  icon?: IconProps["name"]
  variant?: ToastVariant
  duration?: number
  persistent?: boolean
  actions?: ToastAction[]
  /** Text to copy when the user clicks the copy icon in the header. Adds a copy icon button next to the close button. */
  copyText?: string
}

// Persist an error toast to the desktop log file so it remains readable even
// when the toast is dismissed or devtools can't be opened (macOS release builds).
// Also mirrors to localStorage as a fallback in case the Tauri invoke is unavailable
// (e.g. webview global not ready during early startup).
const TOAST_ERR_LS_KEY = "duoduo:frontend-errors"
const TOAST_ERR_LS_MAX = 50

function persistToastError(text: string) {
  try {
    const raw = localStorage.getItem(TOAST_ERR_LS_KEY)
    const arr: Array<{ ts: string; level: string; message: string }> = raw ? JSON.parse(raw) : []
    arr.push({ ts: new Date().toISOString(), level: "error", message: text })
    while (arr.length > TOAST_ERR_LS_MAX) arr.shift()
    localStorage.setItem(TOAST_ERR_LS_KEY, JSON.stringify(arr))
  } catch {
    // non-fatal
  }
}

function logToastError(text: string) {
  persistToastError(text)
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }
  }
  w.__TAURI__?.core?.invoke?.("log_frontend_error", { level: "error", message: text })?.catch?.(() => {})
}

export function showToast(options: ToastOptions | string) {
  const opts = typeof options === "string" ? { description: options } : options
  const isError = (opts.variant ?? "default") === "error"

  // Error toasts carry diagnostic info the user needs to read/copy — keep them
  // on screen until dismissed instead of auto-hiding after the default 5s.
  const persistent = opts.persistent ?? isError
  const duration = opts.duration

  if (isError) {
    const text = [opts.title, opts.description, opts.copyText].filter(Boolean).join("\n")
    if (text) logToastError(text)
  }

  // Per-toast copy feedback state. Created here (not inside the render
  // callback) so it survives re-renders of the toast body.
  const [copied, setCopied] = createSignal(false)

  return toaster.show((props) => (
    <Toast
      toastId={props.toastId}
      duration={duration}
      persistent={persistent}
      data-variant={opts.variant ?? "default"}
    >
      <Show when={opts.icon}>
        <Toast.Icon name={opts.icon!} />
      </Show>
      <Toast.Content>
        <Show when={opts.title}>
          <Toast.Title>{opts.title}</Toast.Title>
        </Show>
        <Show when={opts.description}>
          <Toast.Description>{opts.description}</Toast.Description>
        </Show>
        <Show when={opts.actions?.length}>
          <Toast.Actions>
            {opts.actions!.map((action) => (
              <button
                data-slot="toast-action"
                onClick={() => {
                  if (typeof action.onClick === "function") {
                    action.onClick()
                  }
                  toaster.dismiss(props.toastId)
                }}
              >
                {action.label}
              </button>
            ))}
          </Toast.Actions>
        </Show>
      </Toast.Content>
      <Show when={opts.description || opts.copyText}>
        <IconButton
          data-slot="toast-copy-button"
          icon={copied() ? "check" : "copy"}
          variant="ghost"
          aria-label={copied() ? "Copied" : "Copy"}
          onClick={() => {
            const text = opts.copyText ?? [opts.title, opts.description].filter(Boolean).join(": ")
            void copyToClipboard(text).then((ok) => {
              if (!ok) return
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            })
          }}
        />
      </Show>
      <Toast.CloseButton />
    </Toast>
  ))
}

export interface ToastPromiseOptions<T, U = unknown> {
  loading?: JSX.Element
  success?: (data: T) => JSX.Element
  error?: (error: U) => JSX.Element
}

export function showPromiseToast<T, U = unknown>(
  promise: Promise<T> | (() => Promise<T>),
  options: ToastPromiseOptions<T, U>,
) {
  return toaster.promise(promise, (props) => (
    <Toast
      toastId={props.toastId}
      persistent={props.state === "rejected"}
      data-variant={props.state === "pending" ? "loading" : props.state === "fulfilled" ? "success" : "error"}
    >
      <Toast.Content>
        <Toast.Description>
          {props.state === "pending" && options.loading}
          {props.state === "fulfilled" && options.success?.(props.data!)}
          {props.state === "rejected" && options.error?.(props.error)}
        </Toast.Description>
      </Toast.Content>
      <Toast.CloseButton />
    </Toast>
  ))
}
