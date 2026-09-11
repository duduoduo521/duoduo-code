import { Button } from "@duoduo-ai/ui/button"
import { Icon } from "@duoduo-ai/ui/icon"
import { Keybind } from "@duoduo-ai/ui/keybind"
import { Tooltip, TooltipKeybind } from "@duoduo-ai/ui/tooltip"
import { getFilename } from "@duoduo-ai/shared/util/path"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useTerminal } from "@/context/terminal"
import { focusTerminalById } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { decode64 } from "@/utils/base64"
import { displayName } from "@/pages/layout/helpers"
import { StatusPopover } from "../status-popover"

export function SessionHeader() {
  const layout = useLayout()
  const command = useCommand()
  const platform = usePlatform()
  const language = useLanguage()
  const settings = useSettings()
  const terminal = useTerminal()
  const { params, view } = useSessionLayout()

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const project = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return
    return layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
  })
  const name = createMemo(() => {
    const current = project()
    if (current) return displayName(current)
    return getFilename(projectDirectory())
  })
  const hotkey = createMemo(() => command.keybind("file.open"))
  const isDesktopBeta = platform.platform === "desktop" && import.meta.env.VITE_DUODUO_CHANNEL === "beta"
  const search = createMemo(() => !isDesktopBeta || settings.general.showSearch())
  const tree = createMemo(() => !isDesktopBeta || settings.general.showFileTree())
  const term = createMemo(() => !isDesktopBeta || settings.general.showTerminal())
  const status = createMemo(() => !isDesktopBeta || settings.general.showStatus())

  const toggleTerminal = () => {
    const next = !view().terminal.opened()
    view().terminal.toggle()
    if (!next) return

    const id = terminal.active()
    if (!id) return
    focusTerminalById(id)
  }

  const [centerMount, setCenterMount] = createSignal<HTMLElement | null>(null)
  const [rightMount, setRightMount] = createSignal<HTMLElement | null>(null)
  onMount(() => {
    setCenterMount(document.getElementById("duoduo-titlebar-center"))
    setRightMount(document.getElementById("duoduo-titlebar-right"))
  })

  return (
    <>
      <Show when={search() && centerMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <Button
              type="button"
              variant="ghost"
              size="small"
              class="hidden md:flex w-[240px] max-w-full min-w-0 items-center gap-2 justify-between rounded-md border border-border-weak-base bg-surface-panel shadow-none cursor-default"
              onClick={() => command.trigger("file.open")}
              aria-label={language.t("session.header.searchFiles")}
            >
              <div class="flex min-w-0 flex-1 items-center overflow-visible">
                <span class="flex-1 min-w-0 text-12-regular text-text-weak truncate text-left">
                  {language.t("session.header.search.placeholder", {
                    project: name(),
                  })}
                </span>
              </div>

              <Show when={hotkey()}>
                {(keybind) => (
                  <Keybind class="shrink-0 !border-0 !bg-transparent !shadow-none px-0 text-text-weaker">
                    {keybind()}
                  </Keybind>
                )}
              </Show>
            </Button>
          </Portal>
        )}
      </Show>
      <Show when={rightMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="flex items-center gap-2">
              <div class="flex items-center gap-1">
                <Show when={status()}>
                  <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
                    <StatusPopover />
                  </Tooltip>
                </Show>
                <Show when={term()}>
                  <TooltipKeybind
                    title={language.t("command.terminal.toggle")}
                    keybind={command.keybind("terminal.toggle")}
                  >
                    <Button
                      variant="ghost"
                      class="group/terminal-toggle titlebar-icon w-8 h-6 p-0 box-border shrink-0"
                      onClick={toggleTerminal}
                      aria-label={language.t("command.terminal.toggle")}
                      aria-expanded={view().terminal.opened()}
                      aria-controls="terminal-panel"
                    >
                      <Icon size="small" name={view().terminal.opened() ? "terminal-active" : "terminal"} />
                    </Button>
                  </TooltipKeybind>
                </Show>

                <div class="flex items-center gap-1 shrink-0">
                  <TooltipKeybind
                    title={language.t("command.review.toggle")}
                    keybind={command.keybind("review.toggle")}
                  >
                    <Button
                      variant="ghost"
                      class="group/review-toggle titlebar-icon w-8 h-6 p-0 box-border"
                      onClick={() => view().reviewPanel.toggle()}
                      aria-label={language.t("command.review.toggle")}
                      aria-expanded={view().reviewPanel.opened()}
                      aria-controls="review-panel"
                    >
                      <Icon size="small" name={view().reviewPanel.opened() ? "review-active" : "review"} />
                    </Button>
                  </TooltipKeybind>

                  <Show when={tree()}>
                    <TooltipKeybind
                      title={language.t("command.fileTree.toggle")}
                      keybind={command.keybind("fileTree.toggle")}
                    >
                      <Button
                        variant="ghost"
                        class="titlebar-icon w-8 h-6 p-0 box-border"
                        onClick={() => layout.fileTree.toggle()}
                        aria-label={language.t("command.fileTree.toggle")}
                        aria-expanded={layout.fileTree.opened()}
                        aria-controls="file-tree-panel"
                      >
                        <div class="relative flex items-center justify-center size-4">
                          <Icon
                            size="small"
                            name={layout.fileTree.opened() ? "file-tree-active" : "file-tree"}
                            classList={{
                              "text-icon-strong": layout.fileTree.opened(),
                              "text-icon-weak": !layout.fileTree.opened(),
                            }}
                          />
                        </div>
                      </Button>
                    </TooltipKeybind>
                  </Show>
                </div>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}
