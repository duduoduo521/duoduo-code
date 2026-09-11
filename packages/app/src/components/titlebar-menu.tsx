import { DropdownMenu } from "@duoduo-ai/ui/dropdown-menu"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createSignal, For, onCleanup, Show } from "solid-js"

// ─── Types ────────────────────────────────────────────────────────────

type MenuItemData = { type: "item"; label: string; action: () => void; shortcut?: string } | { type: "separator" }

type MenuGroup = {
  label: string
  items: MenuItemData[]
}

// ─── Platform-aware shortcut helpers ──────────────────────────────────

/** Replace Ctrl→Cmd on macOS for display purposes */
function displayShortcut(shortcut: string, isMac: boolean): string {
  if (!isMac) return shortcut
  return shortcut.replace(/\bCtrl\b/g, "Cmd")
}

// ─── Edit operation helpers ───────────────────────────────────────────

function editAction(command: string) {
  return () => {
    try {
      document.execCommand(command)
    } catch {
      // execCommand may fail in some contexts
    }
  }
}

// ─── Desktop actions (accessed via global Tauri API) ──────────────────

function tauriInvoke(cmd: string) {
  return () => {
    ;(
      window as unknown as {
        __TAURI__?: { core?: { invoke?: (cmd: string) => Promise<unknown> } }
      }
    ).__TAURI__?.core
      ?.invoke?.(cmd)
      ?.catch?.(() => undefined)
  }
}

function tauriProcessReload() {
  return () => window.location.reload()
}

function tauriProcessExit() {
  return () => {
    ;(
      window as unknown as {
        __TAURI__?: {
          process?: { exit?: (code: number) => Promise<void> }
        }
      }
    ).__TAURI__?.process
      ?.exit?.(0)
      ?.catch?.(() => undefined)
  }
}

// ─── Component ────────────────────────────────────────────────────────

export function TitlebarMenu() {
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()

  const desktop = () => platform.platform === "desktop"
  const isMac = () => platform.os === "macos"
  const t = language.t

  // Per-menu "armed" flag used to swallow the stray selection that can happen
  // on the very click that opens a leftmost menu (app / file) on Windows.
  // See the guard below for the full explanation.
  const armedMenus: Record<string, boolean> = {}

  // Menubar interaction state: at most one menu open at a time. Hovering or
  // clicking another trigger while a menu is open switches to it directly,
  // and leaving the menu area auto-closes after a short grace period.
  const [openKey, setOpenKey] = createSignal<string | undefined>(undefined)
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let barEl: HTMLDivElement | undefined
  let contentEl: HTMLElement | undefined
  const cancelScheduledClose = () => {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = undefined
    }
  }
  const scheduleClose = (delay = 300) => {
    cancelScheduledClose()
    closeTimer = setTimeout(() => {
      closeTimer = undefined
      contentEl = undefined
      setOpenKey(undefined)
    }, delay)
  }
  onCleanup(cancelScheduledClose)

  // Close-on-leave is decided by GEOMETRY, not by enter/leave events: the
  // dropdown content is portaled to <body>, so the pointermove/pointerleave
  // pairs crossing that portal boundary can arrive in an order that leaves a
  // scheduled close uncancelled (menu shuts while the pointer is inside the
  // dropdown). Instead, while a menu is open we track the pointer globally:
  // as long as it stays inside the menubar or the open dropdown (with a small
  // bridge over the anchor gap), the menu never closes; once it leaves both
  // regions a single close timer starts (not rescheduled per move).
  const pointerInside = (e: PointerEvent) => {
    const bar = barEl?.getBoundingClientRect()
    if (bar && e.clientX >= bar.left && e.clientX <= bar.right && e.clientY >= bar.top && e.clientY <= bar.bottom) {
      return true
    }
    const content = contentEl?.isConnected ? contentEl.getBoundingClientRect() : undefined
    if (
      content &&
      e.clientX >= content.left - 6 &&
      e.clientX <= content.right + 6 &&
      e.clientY >= content.top - 12 &&
      e.clientY <= content.bottom + 6
    ) {
      return true
    }
    return false
  }
  const onGlobalPointerMove = (e: PointerEvent) => {
    if (!openKey()) return
    if (pointerInside(e)) cancelScheduledClose()
    else if (!closeTimer) scheduleClose()
  }
  document.addEventListener("pointermove", onGlobalPointerMove, { capture: true })
  onCleanup(() => document.removeEventListener("pointermove", onGlobalPointerMove, { capture: true }))

  const menus = (): MenuGroup[] => {
    const appItems: MenuItemData[] = []
    if (desktop()) {
      appItems.push({
        type: "item",
        label: t("desktop.menu.installCli"),
        action: tauriInvoke("plugin:cli|install"),
      })
      appItems.push({
        type: "item",
        label: t("desktop.menu.reloadWebview"),
        action: tauriProcessReload(),
      })
      appItems.push({
        type: "item",
        label: t("desktop.menu.restart"),
        action: tauriInvoke("plugin:process|relaunch"),
      })
      appItems.push({ type: "separator" })
    }
    appItems.push({
      type: "item",
      label: desktop() ? "Quit" : "Close",
      action: desktop() ? tauriProcessExit() : () => window.close(),
      shortcut: desktop() ? "Alt+F4" : undefined,
    })

    return [
      {
        label: t("desktop.menu.app"),
        items: appItems,
      },
      {
        label: t("desktop.menu.file"),
        items: [
          {
            type: "item",
            label: t("desktop.menu.file.newSession"),
            action: () => command.trigger("session.new"),
            shortcut: command.keybind("session.new"),
          },
          {
            type: "item",
            label: t("desktop.menu.file.openProject"),
            action: () => command.trigger("project.open"),
            shortcut: command.keybind("project.open"),
          },
          { type: "separator" },
          {
            type: "item",
            label: "Close Window",
            action: () => {
              if (desktop()) {
                ;(
                  window as unknown as {
                    __TAURI__?: {
                      window?: {
                        getCurrentWindow?: () => { close?: () => Promise<void> }
                      }
                    }
                  }
                ).__TAURI__?.window
                  ?.getCurrentWindow?.()
                  ?.close?.()
                  ?.catch?.(() => undefined)
              } else {
                window.close()
              }
            },
            shortcut: desktop() ? "Alt+F4" : undefined,
          },
        ],
      },
      {
        label: t("desktop.menu.edit"),
        items: [
          {
            type: "item",
            label: "Undo",
            action: editAction("undo"),
            shortcut: displayShortcut("Ctrl+Z", isMac()),
          },
          {
            type: "item",
            label: "Redo",
            action: editAction("redo"),
            shortcut: displayShortcut("Ctrl+Y", isMac()),
          },
          { type: "separator" },
          {
            type: "item",
            label: "Cut",
            action: editAction("cut"),
            shortcut: displayShortcut("Ctrl+X", isMac()),
          },
          {
            type: "item",
            label: "Copy",
            action: editAction("copy"),
            shortcut: displayShortcut("Ctrl+C", isMac()),
          },
          {
            type: "item",
            label: "Paste",
            action: editAction("paste"),
            shortcut: displayShortcut("Ctrl+V", isMac()),
          },
          { type: "separator" },
          {
            type: "item",
            label: "Select All",
            action: editAction("selectAll"),
            shortcut: displayShortcut("Ctrl+A", isMac()),
          },
        ],
      },
      {
        label: t("desktop.menu.view"),
        items: [
          {
            type: "item",
            label: t("desktop.menu.view.toggleSidebar"),
            action: () => command.trigger("sidebar.toggle"),
            shortcut: command.keybind("sidebar.toggle"),
          },
          {
            type: "item",
            label: t("desktop.menu.view.toggleTerminal"),
            action: () => command.trigger("terminal.toggle"),
            shortcut: command.keybind("terminal.toggle"),
          },
          {
            type: "item",
            label: t("desktop.menu.view.toggleFileTree"),
            action: () => command.trigger("fileTree.toggle"),
            shortcut: command.keybind("fileTree.toggle"),
          },
          { type: "separator" },
          {
            type: "item",
            label: t("desktop.menu.view.back"),
            action: () => command.trigger("common.goBack"),
            shortcut: command.keybind("common.goBack"),
          },
          {
            type: "item",
            label: t("desktop.menu.view.forward"),
            action: () => command.trigger("common.goForward"),
            shortcut: command.keybind("common.goForward"),
          },
          { type: "separator" },
          {
            type: "item",
            label: t("desktop.menu.view.previousSession"),
            action: () => command.trigger("session.previous"),
            shortcut: command.keybind("session.previous"),
          },
          {
            type: "item",
            label: t("desktop.menu.view.nextSession"),
            action: () => command.trigger("session.next"),
            shortcut: command.keybind("session.next"),
          },
        ],
      },
      {
        label: t("desktop.menu.help"),
        items: [
          {
            type: "item",
            label: t("desktop.menu.help.aboutUs"),
            action: () => command.trigger("about.open"),
          },
          { type: "separator" },
          {
            type: "item",
            label: t("desktop.menu.help.website"),
            action: () => platform.openLink("https://www.dd322.cn/code"),
          },
        ],
      },
    ]
  }

  return (
    <div
      ref={(el: HTMLDivElement) => {
        barEl = el
      }}
      data-slot="titlebar-menu"
      class="hidden xl:flex items-center shrink-0 h-full"
    >
      <For each={menus()}>
        {(group) => {
          const key = group.label
          // Guard against the "opening click instantly selects an item" bug.
          //
          // On Windows the titlebar menus open on pointer-down. Kobalte mounts
          // the popper initially at the viewport top-left (top:0; left:0) and
          // only moves it under the trigger after floating-ui's async
          // computePosition resolves. For the leftmost menus (app / file) the
          // mispositioned content briefly sits under the cursor, so the very
          // pointer-up that releases the opening press lands on a menu item
          // (Kobalte selects on pointer-up with allowsDifferentPressOrigin) —
          // e.g. instantly triggering "New session" from the File menu.
          //
          // We distinguish the stray release from a genuine click purely by
          // whether the menu content itself ever received a real pointer-down:
          //   * the opening press-down happens on the TRIGGER, not the content,
          //     so the stray release has NO pointer-down on the content;
          //   * a genuine item click always has a pointer-down on the content
          //     first.
          // We "arm" the menu on trigger pointer-down, disarm it as soon as the
          // content gets a pointer-down, and swallow any pointer-up/click that
          // occurs while still armed (plus tiny mouse jitter will NOT disarm it,
          // unlike a pointer-move heuristic).
          const guardContent = (el: HTMLElement) => {
            contentEl = el
            el.addEventListener(
              "pointerdown",
              () => {
                armedMenus[key] = false
              },
              { capture: true },
            )
            el.addEventListener(
              "pointerup",
              (e) => {
                if (armedMenus[key]) {
                  e.preventDefault()
                  e.stopPropagation()
                }
              },
              { capture: true },
            )
            el.addEventListener(
              "click",
              (e) => {
                if (armedMenus[key]) {
                  e.preventDefault()
                  e.stopPropagation()
                  armedMenus[key] = false
                }
              },
              { capture: true },
            )
          }
          return (
            <DropdownMenu
              open={openKey() === key}
              onOpenChange={(open) => {
                if (open) {
                  cancelScheduledClose()
                  setOpenKey(key)
                } else if (openKey() === key) {
                  cancelScheduledClose()
                  setOpenKey(undefined)
                }
              }}
            >
              <DropdownMenu.Trigger
                as="button"
                onPointerDown={() => {
                  armedMenus[key] = true
                  // Clicking another trigger while a menu is open switches to
                  // it directly instead of requiring a dismiss click first.
                  if (openKey() && openKey() !== key) {
                    cancelScheduledClose()
                    setOpenKey(key)
                  }
                }}
                onPointerEnter={() => {
                  // Hovering another trigger while a menu is open immediately
                  // dismisses the current dropdown (no auto-switch; the new
                  // menu opens on click, like a plain menubar).
                  if (openKey() && openKey() !== key) {
                    cancelScheduledClose()
                    contentEl = undefined
                    setOpenKey(undefined)
                  }
                }}
                class="h-full px-2 text-12-medium text-text-weak hover:text-text-base hover:bg-surface-base-hover data-[expanded]:text-text-base data-[expanded]:bg-surface-base-hover rounded-md transition-colors select-none cursor-default"
              >
                {group.label}
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content ref={guardContent} class="min-w-[200px] mt-1 p-1">
                  <For each={group.items}>
                    {(item) => (
                      <Show
                        when={item.type === "separator"}
                        fallback={
                          <DropdownMenu.Item
                            onSelect={() => {
                              const i = item as Extract<MenuItemData, { type: "item" }>
                              // Defer action so the dropdown closes and releases focus before
                              // the action potentially opens a dialog — avoids aria-hidden warning
                              setTimeout(() => i.action(), 0)
                            }}
                            class="flex items-center justify-between gap-8 rounded-md px-3 py-1.5 text-13-regular text-text-base data-[highlighted]:bg-surface-base-hover cursor-default"
                          >
                            <DropdownMenu.ItemLabel>
                              {(item as Extract<MenuItemData, { type: "item" }>).label}
                            </DropdownMenu.ItemLabel>
                            <Show when={(item as Extract<MenuItemData, { type: "item" }>).shortcut}>
                              <span class="text-11-regular text-text-weakest tabular-nums ml-auto">
                                {(item as Extract<MenuItemData, { type: "item" }>).shortcut}
                              </span>
                            </Show>
                          </DropdownMenu.Item>
                        }
                      >
                        <DropdownMenu.Separator class="my-1 border-t border-border-weak-base" />
                      </Show>
                    )}
                  </For>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
          )
        }}
      </For>
    </div>
  )
}
