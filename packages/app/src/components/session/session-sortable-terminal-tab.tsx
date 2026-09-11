import type { JSX } from "solid-js"
import { Show, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSafeSortable } from "@/utils/solid-dnd"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { Tabs } from "@duoduo-ai/ui/tabs"
import { ContextMenu } from "@duoduo-ai/ui/context-menu"
import { isDefaultTitle as isDefaultTerminalTitle } from "@/context/terminal-title"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { useLanguage } from "@/context/language"
import { focusTerminalById } from "@/pages/session/helpers"

export function SortableTerminalTab(props: { terminal: LocalPTY; onClose?: () => void }): JSX.Element {
  const terminal = useTerminal()
  const language = useLanguage()
  const sortable = createSafeSortable(props.terminal.id)
  const [store, setStore] = createStore({
    editing: false,
    title: props.terminal.title,
    blurEnabled: false,
  })
  let input: HTMLInputElement | undefined
  let blurFrame: number | undefined

  const isDefaultTitle = () => {
    const number = props.terminal.titleNumber
    if (!Number.isFinite(number) || number <= 0) return false
    return isDefaultTerminalTitle(props.terminal.title, number)
  }

  const label = () => {
    language.locale()
    if (props.terminal.title && !isDefaultTitle()) return props.terminal.title

    const number = props.terminal.titleNumber
    if (Number.isFinite(number) && number > 0) return language.t("terminal.title.numbered", { number })
    if (props.terminal.title) return props.terminal.title
    return language.t("terminal.title")
  }

  const close = () => {
    const count = terminal.all().length
    void terminal.close(props.terminal.id)
    if (count === 1) {
      props.onClose?.()
    }
  }

  const focus = () => {
    if (store.editing) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    focusTerminalById(props.terminal.id)
  }

  const edit = (e?: Event) => {
    if (e) {
      e.stopPropagation()
      e.preventDefault()
    }

    setStore("blurEnabled", false)
    setStore("title", props.terminal.title)
    setStore("editing", true)
  }

  const save = () => {
    if (!store.blurEnabled) return

    const value = store.title.trim()
    if (value && value !== props.terminal.title) {
      terminal.update({ id: props.terminal.id, title: value })
    }
    setStore("editing", false)
  }

  const keydown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      save()
      return
    }
    if (e.key === "Escape") {
      e.preventDefault()
      setStore("editing", false)
    }
  }

  createEffect(() => {
    if (!store.editing) return
    if (!input) return
    input.focus()
    input.select()
    if (blurFrame !== undefined) cancelAnimationFrame(blurFrame)
    blurFrame = requestAnimationFrame(() => {
      blurFrame = undefined
      setStore("blurEnabled", true)
    })
  })

  onCleanup(() => {
    if (blurFrame === undefined) return
    cancelAnimationFrame(blurFrame)
  })

  return (
    <div
      use:sortable
      class="outline-none focus:outline-none focus-visible:outline-none"
      classList={{
        "h-full": true,
        "opacity-0": sortable.isActiveDraggable,
      }}
    >
      <div class="relative h-full">
        <ContextMenu>
          <ContextMenu.Trigger>
            <Tabs.Trigger
              value={props.terminal.id}
              onClick={focus}
              onMouseDown={(e) => e.preventDefault()}
              class="!shadow-none"
              classes={{
                button: "border-0 outline-none focus:outline-none focus-visible:outline-none !shadow-none !ring-0",
              }}
              closeButton={
                <IconButton
                  icon="close"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation()
                    close()
                  }}
                  aria-label={language.t("terminal.close")}
                />
              }
            >
              <span onDblClick={edit} classList={{ invisible: store.editing }}>
                {label()}
              </span>
            </Tabs.Trigger>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content>
              <ContextMenu.Item onSelect={() => edit()}>
                <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={close}>
                <ContextMenu.ItemLabel>{language.t("common.close")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu>
        <Show when={store.editing}>
          <div class="absolute inset-0 flex items-center px-3 bg-muted z-10 pointer-events-auto">
            <input
              ref={input}
              type="text"
              value={store.title}
              onInput={(e) => setStore("title", e.currentTarget.value)}
              onBlur={save}
              onKeyDown={keydown}
              onMouseDown={(e) => e.stopPropagation()}
              class="bg-transparent border-none outline-none text-sm min-w-0 flex-1"
            />
          </div>
        </Show>
      </div>
    </div>
  )
}
