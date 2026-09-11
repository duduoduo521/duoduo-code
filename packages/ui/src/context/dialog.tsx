import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"

type DialogElement = () => JSX.Element

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  setClosing: (closing: boolean) => void
  isClosing: () => boolean
  disposed: boolean
  // How this dialog closes: "back" returns to the previous dialog in the
  // history stack (e.g. a sub-dialog closing back into Settings), while
  // "close" tears down the whole stack.
  dismiss: "back" | "close"
}

const Context = createContext<ReturnType<typeof init>>()

function init() {
  const [active, setActive] = createSignal<Active | undefined>()
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const lock = { value: false }
  // Stack of previously shown dialogs, used for "back" navigation.
  const history: Active[] = []

  const clearTimer = () => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
  }

  const safeDispose = (item?: Active) => {
    if (!item || item.disposed) return
    item.disposed = true
    item.dispose()
  }

  // Keep the dialog mounted just long enough for Kobalte's close animation to
  // play (see `data-transition` in dialog.css: contentHide/overlayHide ~140ms),
  // then tear it down. Disposing synchronously instead would unmount the whole
  // tree in a single frame — on a heavy dialog (e.g. the market with dozens of
  // cards) that blocks the main thread and reads as the UI "freezing". The fade
  // is already done by the time we dispose, so the teardown is invisible.
  const CLOSE_ANIM_MS = 200

  // Fully close the whole dialog stack.
  const close = () => {
    const current = active()
    if (!current || lock.value) return
    lock.value = true
    current.onClose?.()
    // Flip `open` to false -> Kobalte starts the exit animation. `active` is
    // left untouched so the node stays mounted and the fade-out is visible.
    current.setClosing(true)

    const id = current.id
    clearTimer()
    timer.current = setTimeout(() => {
      timer.current = undefined
      safeDispose(current)
      for (const item of history) safeDispose(item)
      history.length = 0
      if (active()?.id === id) setActive(undefined)
      lock.value = false
    }, CLOSE_ANIM_MS)
  }

  // Navigate back to the previous dialog, or close everything if none.
  const back = () => {
    const current = active()
    if (!current || lock.value) return
    lock.value = true
    current.onClose?.()
    current.setClosing(true)

    // Return to the EARLIEST dialog still on the history stack (normally the
    // Settings dialog). The stack is used only as a flat two-level chain
    // (Settings -> sub-dialog), so history[0] is always the correct parent.
    // Returning to history[0] instead of history.pop() also guards against a
    // stale/duplicated entry left over from an incompletely-torn-down prior
    // sub-dialog, which would otherwise become the back target and make e.g.
    // closing "add DeepSeek" jump back into "add custom" instead of Settings.
    const prev = history[0]
    const rest = history.slice(1)
    clearTimer()
    timer.current = setTimeout(() => {
      timer.current = undefined
      safeDispose(current)
      for (const item of rest) safeDispose(item)
      history.length = 0
      if (prev && !prev.disposed) {
        setActive(prev)
      } else if (active()?.id === current.id) {
        setActive(undefined)
      }
      lock.value = false
    }, CLOSE_ANIM_MS)
  }

  // Dismiss the current dialog according to its configured mode: "back"
  // returns to the previous dialog (e.g. a sub-dialog closing back into
  // Settings), while "close" tears down the whole stack.
  const dismissActive = () => {
    const current = active()
    if (!current) return
    if (current.dismiss === "back") back()
    else close()
  }

  createEffect(() => {
    if (!active()) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      dismissActive()
      event.preventDefault()
      event.stopPropagation()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  const show = (
    element: DialogElement,
    owner: Owner,
    onClose?: () => void,
    dismiss: "back" | "close" = "close",
  ) => {
    const current = active()
    clearTimer()
    lock.value = false

    // Decide what happens to the currently-active dialog when a new one opens:
    //
    // 1. If it is *already closing* (the caller already invoked dialog.close(),
    //    e.g. the model-select dialog handing off to the connect-provider dialog),
    //    tear it down immediately. Its Kobalte overlay Portal is still mounted
    //    during the 200ms exit animation; leaving it would stack a second 0.55
    //    overlay on top of the new dialog's overlay for those frames — the exact
    //    "opaque mask first, then semi-transparent mask" white-flash symptom.
    //    Disposing now unmounts that Portal synchronously, so only the new
    //    dialog's overlay is ever visible.
    // 2. Otherwise keep it on the history stack so "back" can return to it.
    if (current && !current.disposed && current.isClosing()) {
      safeDispose(current)
    } else if (current && !current.disposed) {
      current.setClosing(false)
      history.push(current)
    }

    const id = Math.random().toString(36).slice(2)
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined
    let isClosing: (() => boolean) | undefined

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closing, setClosingSignal] = createSignal(false)
        setClosing = setClosingSignal
        isClosing = closing
        return (
          <Kobalte
            modal
            open={!closing()}
            onOpenChange={(open: boolean) => {
              if (open) return
              dismissActive()
            }}
          >
            <Kobalte.Portal>
              <Kobalte.Overlay data-component="dialog-overlay" />
              {element()}
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing || !isClosing) return

    const closing = isClosing
    setActive({ id, node, dispose, owner, onClose, setClosing, isClosing: () => closing(), disposed: false, dismiss })
  }

  return {
    get active() {
      return active()
    },
    back,
    close,
    show,
  }
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">{ctx.active?.node}</div>
    </Context.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  return {
    get active() {
      return ctx.active
    },
    show(element: DialogElement, onClose?: () => void, dismiss?: "back" | "close") {
      // Always create the new dialog under the *caller's* owner (the page/component
      // that invoked useDialog), NOT the owner of the currently-active dialog.
      //
      // The active dialog may itself have been spawned by `dialog.show`, so its
      // owner lives under the dialog-stack root — which sits OUTSIDE app-level
      // providers like GlobalSyncProvider. Inheriting that owner would strip the
      // new dialog of those contexts, so a component calling e.g. `useGlobalSync()`
      // would throw "must be used within GlobalSyncProvider". Spawning from the
      // caller's owner keeps the full app context chain intact.
      const base = owner
      ctx.show(element, base, onClose, dismiss ?? "close")
    },
    back() {
      ctx.back()
    },
    close() {
      ctx.close()
    },
  }
}
