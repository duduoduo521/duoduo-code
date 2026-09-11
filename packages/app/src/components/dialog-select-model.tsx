import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, JSX, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Button } from "@duoduo-ai/ui/button"
import { IconButton } from "@duoduo-ai/ui/icon-button"

import { Tag } from "@duoduo-ai/ui/tag"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { DialogConfirm } from "./dialog-confirm"
import { List } from "@duoduo-ai/ui/list"
import { Tooltip } from "@duoduo-ai/ui/tooltip"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { normalizeProviderList } from "@/context/global-sync/utils"
import { useProviders } from "@/hooks/use-providers"
import { getSessionContextMetrics } from "./session/session-context-metrics"
import { showToast } from "@duoduo-ai/ui/toast"
import { DialogSettings } from "./dialog-settings"

type ModelState = ReturnType<typeof useLocal>["model"]

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelState
  sessionID?: string
}> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()
  const dialog = useDialog()
  const sync = useSync()
  const providers = useProviders()

  const models = createMemo(() =>
    model.list().filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  /** Check if switching to a smaller model would risk overflow, and show a confirmation dialog if so. */
  const confirmModelSwitch = (newModel: {
    id: string
    provider: { id: string }
    limit: { context: number }
  }): boolean => {
    const current = model.current()
    if (!current) return true // No current model, no risk

    const currentCtx = current.limit.context || 128000
    const newCtx = newModel.limit.context || 128000

    // Only warn when switching to a smaller context model
    if (newCtx >= currentCtx) return true

    // Estimate current session token usage
    const sessionID = props.sessionID
    if (!sessionID) return true
    const messages = sync.data.message[sessionID] ?? []
    if (!messages.length) return true

    const metrics = getSessionContextMetrics(messages, providers.all())
    const sessionTokens = metrics.context?.sessionTotal ?? 0
    if (sessionTokens === 0) return true // No token data yet, no risk

    // Warn if session tokens exceed 65% of the new model's context limit
    const threshold = newCtx * 0.65
    if (sessionTokens <= threshold) return true

    // Show confirmation dialog (synchronous — returns false to block, dialog callback proceeds)
    let confirmed = false
    dialog.show(() => (
      <DialogConfirmModelSwitch
        sessionTokens={sessionTokens}
        newModelName={newModel.id}
        newContextLimit={newCtx}
        onConfirm={() => {
          confirmed = true
          model.set({ modelID: newModel.id, providerID: newModel.provider.id }, { recent: true })
          props.onSelect()
        }}
        onCancel={() => {
          // User cancelled — do nothing
        }}
      />
    ))
    return false
  }

  return (
    <List
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={model.current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={(a, b) => a.category.localeCompare(b.category)}
      itemWrapper={(item, node) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          value={<ModelTooltip model={item} latest={item.latest} free={false} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x) => {
        if (!x) {
          model.set(undefined, { recent: true })
          props.onSelect()
          return
        }
        // Check if we need to warn about context overflow
        if (!confirmModelSwitch(x)) return
        model.set(
          { modelID: x.id, providerID: x.provider.id },
          {
            recent: true,
          },
        )
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full flex items-center gap-x-2 text-13-regular">
          <span class="truncate">{i.name}</span>

          <Show when={i.latest}>
            <Tag>{language.t("model.tag.latest")}</Tag>
          </Show>
        </div>
      )}
    </List>
  )
}

/** Confirmation dialog shown when switching to a smaller context model with a large session. */
function DialogConfirmModelSwitch(props: {
  sessionTokens: number
  newModelName: string
  newContextLimit: number
  onConfirm: () => void
  onCancel: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()

  const handleConfirm = () => {
    dialog.close()
    props.onConfirm()
  }

  const handleCancel = () => {
    dialog.close()
    props.onCancel()
  }

  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
    return String(n)
  }

  return (
    <DialogConfirm
      title={language.t("dialog.model.switch.confirm.title")}
      message={language.t("dialog.model.switch.confirm.description", {
        tokens: formatTokens(props.sessionTokens),
        model: props.newModelName,
        limit: formatTokens(props.newContextLimit),
      })}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type Dismiss = "escape" | "outside" | "select" | "provider"

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelState
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: (cause: "escape" | "select") => void
  sessionID?: string
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()

  // Debounce refresh: don't refresh more than once per 10 seconds
  let lastRefresh = 0

  // LAN scan state (module-level so it persists across open/close)
  const [lanScan, setLanScan] = createStore<{ status: "idle" | "scanning" }>({ status: "idle" })

  const refreshProviders = async () => {
    const now = Date.now()
    if (now - lastRefresh < 10000) return
    lastRefresh = now
    try {
      // refresh: true makes the server re-probe local inference services so a
      // framework started after launch (Ollama, LM Studio, ...) shows up.
      const result = await globalSDK.client.provider.list({ refresh: "true" })
      if (result.data) {
        globalSync.set("provider", normalizeProviderList(result.data))
      }
    } catch {
      // Silent fail — stale data is better than blocking the UI
    }
  }

  const handleScanLan = async () => {
    if (lanScan.status === "scanning") return
    setLanScan("status", "scanning")
    try {
      const result = (await globalSDK.client.provider.scanLan()) as any
      const found = result?.data?.found ?? 0
      if (found > 0) {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("model.scan.lan.found", { count: found }),
        })
        // Refresh provider list to show newly discovered models
        const list = await globalSDK.client.provider.list({ refresh: "true" })
        if (list.data) {
          globalSync.set("provider", normalizeProviderList(list.data))
        }
      } else {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("model.scan.lan.none"),
        })
      }
    } catch {
      showToast({
        variant: "error",
        icon: "circle-x",
        title: language.t("model.scan.lan.error"),
      })
    } finally {
      setLanScan("status", "idle")
    }
  }

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  // Open the Settings dialog directly on the Providers tab. Replaces the old
  // "add custom / add deepseek" dropdown: the Providers tab already exposes the
  // same add actions, and routing through Settings avoids the buggy popover ->
  // connect-dialog transition.
  const openSettingsProviders = () => {
    close("select")
    dialog.show(() => <DialogSettings initialTab="providers" />)
  }

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) {
          setStore("dismiss", null)
          void refreshProviders()
        }
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          class="w-72 h-80 flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={props.model}
            sessionID={props.sessionID}
            onSelect={() => close("select")}
            class="p-1"
            action={
              <div class="flex items-center gap-1">
                <Tooltip placement="top" value={language.t("model.scan.lan.button")}>
                  <IconButton
                    icon="server"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("model.scan.lan.button")}
                    disabled={lanScan.status === "scanning"}
                    onClick={handleScanLan}
                  />
                </Tooltip>
                <Tooltip placement="top" value={language.t("command.provider.connect")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("command.provider.connect")}
                    onClick={() => openSettingsProviders()}
                  />
                </Tooltip>
              </div>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState; sessionID?: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  // Open the Settings dialog on the Providers tab (replaces the add dropdown).
  const openSettingsProviders = () => {
    dialog.close()
    dialog.show(() => <DialogSettings initialTab="providers" />)
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      transition={false}
      action={
        <Button
          class="h-7 -my-1 text-14-medium"
          icon="plus-small"
          tabIndex={-1}
          onClick={() => openSettingsProviders()}
        >
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList
        provider={props.provider}
        model={props.model}
        sessionID={props.sessionID}
        onSelect={() => dialog.close()}
      />
    </Dialog>
  )
}
