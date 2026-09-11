import { createMemo, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createSafeSortable } from "@/utils/solid-dnd"
import { FileIcon } from "@duoduo-ai/ui/file-icon"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { TooltipKeybind } from "@duoduo-ai/ui/tooltip"
import { Tabs } from "@duoduo-ai/ui/tabs"
import { ContextMenu } from "@duoduo-ai/ui/context-menu"
import { getFilename } from "@duoduo-ai/shared/util/path"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"

export function FileVisual(props: { path: string; active?: boolean }): JSX.Element {
  return (
    <div class="flex items-center gap-x-1.5 min-w-0">
      <Show
        when={!props.active}
        fallback={<FileIcon node={{ path: props.path, type: "file" }} class="size-4 shrink-0" />}
      >
        <span class="relative inline-flex size-4 shrink-0">
          <FileIcon node={{ path: props.path, type: "file" }} class="absolute inset-0 size-4 tab-fileicon-color" />
          <FileIcon node={{ path: props.path, type: "file" }} mono class="absolute inset-0 size-4 tab-fileicon-mono" />
        </span>
      </Show>
      <span class="text-14-medium truncate">{getFilename(props.path)}</span>
    </div>
  )
}

export function SortableTab(props: {
  tab: string
  onTabClose: (tab: string) => void
  onTabSwitch?: (tab: string) => void
  onTabCloseOthers: (tab: string) => void
  onTabCloseToRight: (tab: string) => void
  onTabCloseAll: () => void
  onCopyPath: (tab: string) => void
  onCopyRelativePath: (tab: string) => void
  onRevealInFileTree: (tab: string) => void
}): JSX.Element {
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const sortable = createSafeSortable(props.tab)
  const path = createMemo(() => file.pathFromTab(props.tab))
  const content = createMemo(() => {
    const value = path()
    if (!value) return
    return <FileVisual path={value} />
  })
  return (
    <div
      use:sortable
      class="h-full flex items-center"
      classList={{ "opacity-0": sortable.isActiveDraggable }}
      onPointerDown={(e) => {
        // Prevent the sortable DnD system from capturing right-click pointerdown
        // events. In Chromium-based browsers, calling preventDefault() on
        // pointerdown blocks the contextmenu event from firing, which prevents
        // the Kobalte ContextMenu from appearing.
        if (e.button === 2) {
          e.stopPropagation()
        }
      }}
    >
      <div class="relative">
        <ContextMenu>
          <ContextMenu.Trigger>
            <Tabs.Trigger
              value={props.tab}
              onClick={() => props.onTabSwitch?.(props.tab)}
              closeButton={
                <TooltipKeybind
                  title={language.t("common.closeTab")}
                  keybind={command.keybind("tab.close")}
                  placement="bottom"
                  gutter={10}
                >
                  <IconButton
                    icon="close-small"
                    variant="ghost"
                    class="h-5 w-5"
                    onClick={() => props.onTabClose(props.tab)}
                    aria-label={language.t("common.closeTab")}
                  />
                </TooltipKeybind>
              }
              hideCloseButton
              onMiddleClick={() => props.onTabClose(props.tab)}
            >
              <Show when={content()}>{(value) => value()}</Show>
            </Tabs.Trigger>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content>
              <ContextMenu.Item onSelect={() => props.onTabClose(props.tab)}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.tab.close")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={() => props.onTabCloseOthers(props.tab)}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.tab.closeOthers")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={() => props.onTabCloseToRight(props.tab)}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.tab.closeRight")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={() => props.onTabCloseAll()}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.tab.closeAll")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onSelect={() => props.onCopyPath(props.tab)}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.tab.copyPath")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={() => props.onCopyRelativePath(props.tab)}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.tab.copyRelativePath")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onSelect={() => props.onRevealInFileTree(props.tab)}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.tab.revealInFileTree")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu>
      </div>
    </div>
  )
}
