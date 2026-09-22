import { Button } from "@duoduo-ai/ui/button"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { DropdownMenu } from "@duoduo-ai/ui/dropdown-menu"
import { Icon } from "@duoduo-ai/ui/icon"
import { Tag } from "@duoduo-ai/ui/tag"
import { showToast } from "@duoduo-ai/ui/toast"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { TextField } from "@duoduo-ai/ui/text-field"

import { useProviders } from "@/hooks/use-providers"
import { useParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import { useSmartLayer } from "@/addons/smart-layer/context"
import { createMemo, createSignal, createEffect, onMount, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { normalizeProviderList } from "@/context/global-sync/utils"
import { useModels } from "@/context/models"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { DialogCustomProvider } from "./dialog-custom-provider"
import { DialogEditBuiltinProvider } from "./dialog-edit-builtin-provider"
import { SettingsList } from "./settings-list"
import { SettingsPage } from "./settings-page"
import { DialogConfirm } from "./dialog-confirm"

type ProviderSource = "env" | "api" | "config" | "custom"
type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

type ModelRowProps = {
  model: { id: string; name: string; limit?: { context?: number; output?: number; input?: number } }
  providerID: string
  canRemoveModels: boolean
  editable: boolean
  formatTokens: (n: number) => string
  saveModelLimit: (
    providerID: string,
    modelID: string,
    contextStr: string,
    outputStr: string,
    inputStr: string,
  ) => Promise<void>
  removeModel: (providerID: string, modelID: string) => Promise<void>
}

// Built-in providers shipped by the app itself. Keep in sync with
// BUILTIN_PROVIDER_IDS in packages/duoduo/src/provider/provider.ts.
const BUILTIN_PROVIDER_IDS = new Set(["deepseek"])

const ModelRow: Component<ModelRowProps> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const [isEditing, setIsEditing] = createSignal(false)
  const [contextLimit, setContextLimit] = createSignal("")
  const [outputLimit, setOutputLimit] = createSignal("")
  const [inputLimit, setInputLimit] = createSignal("")

  // Keep the editor inputs in sync with the (possibly reused) row's model:
  // <For> recycles DOM rows, so a signal initialized only once would show a
  // previous model's limits after list changes.
  createEffect(() => {
    const limit = props.model.limit
    setContextLimit(limit?.context && limit.context > 0 ? String(limit.context) : "")
    setOutputLimit(limit?.output && limit.output > 0 ? String(limit.output) : "")
    setInputLimit(String(limit?.input ?? ""))
  })

  return (
    <div>
      {/* Make the entire model row clickable to expand the limit editor, but only for editable (custom/local) models. */}
      <div
        class={[
          "group/model flex items-center justify-between gap-3 py-1.5 px-2 rounded-md",
          props.editable ? "hover:bg-surface-raised-base cursor-pointer" : "cursor-default",
        ].join(" ")}
        onClick={() => props.editable && setIsEditing(!isEditing())}
      >
        <span class="text-13-regular text-text-strong truncate">{props.model.name}</span>
        <div class="flex items-center gap-1">
          <span class="text-11-regular text-text-weak hover:underline">
            {(() => {
              const ctx =
                props.model.limit?.context && props.model.limit.context > 0 ? props.model.limit.context : 128000
              return `${props.formatTokens(ctx)} ctx`
            })()}
          </span>
          <Show when={props.canRemoveModels}>
            {/* stopPropagation prevents clicking trash from opening the editor */}
            <div onClick={(e) => e.stopPropagation()}>
              <IconButton
                icon="trash"
                variant="ghost"
                class="size-5 opacity-0 group-hover/model:opacity-100 transition-opacity"
                aria-label={language.t("settings.providers.model.remove")}
                onClick={() =>
                  dialog.show(
                    () => (
                      <ConfirmDeleteModel
                        providerID={props.providerID}
                        modelID={props.model.id}
                        onConfirm={() => void props.removeModel(props.providerID, props.model.id)}
                      />
                    ),
                    undefined,
                    "back",
                  )
                }
              />
            </div>
          </Show>
        </div>
      </div>
      <Show when={isEditing()}>
        <div class="ml-4 mt-1 mb-2 p-3 rounded-md bg-surface-raised-base border border-border-weak-base flex flex-col gap-2">
          <div class="flex items-center gap-3">
            <label class="text-12-regular text-text-weak w-28 shrink-0">
              {language.t("settings.providers.model.contextLimit")}
            </label>
            <input
              type="number"
              class="flex-1 min-w-0 px-2 py-1 text-13-regular bg-surface-base border border-border-weak-base rounded-md outline-none focus:border-accent-base"
              value={contextLimit()}
              onInput={(e) => setContextLimit(e.currentTarget.value)}
            />
          </div>
          <div class="flex items-center gap-3">
            <label class="text-12-regular text-text-weak w-28 shrink-0">
              {language.t("settings.providers.model.outputLimit")}
            </label>
            <input
              type="number"
              class="flex-1 min-w-0 px-2 py-1 text-13-regular bg-surface-base border border-border-weak-base rounded-md outline-none focus:border-accent-base"
              value={outputLimit()}
              onInput={(e) => setOutputLimit(e.currentTarget.value)}
            />
          </div>
          <div class="flex items-center gap-3">
            <label class="text-12-regular text-text-weak w-28 shrink-0">
              {language.t("settings.providers.model.inputLimit")}
            </label>
            <input
              type="number"
              class="flex-1 min-w-0 px-2 py-1 text-13-regular bg-surface-base border border-border-weak-base rounded-md outline-none focus:border-accent-base"
              value={inputLimit()}
              onInput={(e) => setInputLimit(e.currentTarget.value)}
              placeholder="(auto)"
            />
          </div>
          <div class="flex justify-end gap-2 mt-1">
            <Button size="small" variant="secondary" onClick={() => setIsEditing(false)}>
              {language.t("settings.providers.model.cancel")}
            </Button>
            <Button
              size="small"
              variant="primary"
              onClick={() => {
                void props.saveModelLimit(props.providerID, props.model.id, contextLimit(), outputLimit(), inputLimit())
                setIsEditing(false)
              }}
            >
              {language.t("settings.providers.model.save")}
            </Button>
          </div>
        </div>
      </Show>
    </div>
  )
}

const ConfirmDeleteModel: Component<{
  providerID: string
  modelID: string
  onConfirm: () => void
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <DialogConfirm
      title={language.t("settings.providers.model.confirmDelete.title")}
      danger
      confirmLabel={language.t("common.delete")}
      message={language.t("settings.providers.model.confirmDelete", {
        provider: props.providerID,
        model: props.modelID,
      })}
      onConfirm={() => {
        props.onConfirm()
        dialog.back()
      }}
      onCancel={() => dialog.back()}
    />
  )
}

const ListEmptyState: Component<{ message: string }> = (props) => {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="text-14-regular text-text-weak">{props.message}</span>
    </div>
  )
}

export const SettingsProviders: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const providers = useProviders()
  const models = useModels()
  const sl = useSmartLayer()

  // Track which providers have their key stored in the OS keyring
  const [keyringProviders, setKeyringProviders] = createSignal(new Set())

  // Check keyring status for connected providers (once when smart layer connects)
  createEffect(() => {
    if (sl.status !== "connected" || !sl.api) return
    const api = sl.api
    const connected = providers.connected()
    for (const p of connected) {
      if (source(p) === "api") {
        api
          .keyringHas(p.id ?? "")
          .then((result) => {
            if (result.hasKey) {
              setKeyringProviders((prev) => {
                const next = new Set(prev)
                next.add(p.id ?? "")
                return next
              })
            }
          })
          .catch(() => {})
      }
    }
  })

  // Track which providers are expanded
  const [expanded, setExpanded] = createSignal(new Set())

  const toggleExpand = (providerID: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(providerID)) {
        next.delete(providerID)
      } else {
        next.add(providerID)
      }
      return next
    })
  }

  const connected = createMemo(() => {
    return providers.connected()
  })

  const source = (item: ProviderItem): ProviderSource | undefined => {
    if (!("source" in item)) return
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  const type = (item: ProviderItem) => {
    const current = source(item)
    if (current === "env") return language.t("settings.providers.tag.environment")
    if (current === "api") return language.t("provider.connect.method.apiKey")
    if (current === "config") {
      if (isConfigCustom(item.id)) return language.t("settings.providers.tag.custom")
      return language.t("settings.providers.tag.config")
    }
    if (current === "custom") return language.t("settings.providers.tag.custom")
    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) => source(item) !== "env"

  const isConfigCustom = (providerID: string) => {
    const provider = globalSync.data.config.provider?.[providerID]
    if (!provider) return false
    if (provider.npm !== "@ai-sdk/openai-compatible") return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return true
  }

  // Whether a provider was added via config (custom/local) — its models can be individually removed
  const isConfigProvider = (providerID: string) => {
    return !!globalSync.data.config.provider?.[providerID]
  }

  // Built-in provider (e.g. deepseek) shipped by the app itself — its only
  // user-editable field is the API key. Determined by identity, NOT by the
  // (possibly stale) connected state: the list rows render from the child
  // store while the connected check used to read the global store, and the
  // two disagree right after connecting, which made the edit button open the
  // full custom-provider editor instead of the key-only one.
  const isBuiltinProvider = (providerID: string) => BUILTIN_PROVIDER_IDS.has(providerID)

  // Get models for a specific provider
  const providerModels = (providerID: string) => {
    return models.list().filter((m) => m.provider.id === providerID)
  }

  // Optimistically remove a provider from the connected list so the UI
  // updates immediately, without waiting for the server round-trip.
  // Updates BOTH the global store and the active project (child) store, since
  // use-providers.ts reads the child store when a project directory is open
  // (e.g. the AI chat model picker) — updating only the global store would
  // leave the in-project picker stale until a full refresh.
  const params = useParams()
  const currentDir = () => decode64(params.dir) ?? ""
  // Optimistically remove a provider from the connected list so the UI
  // updates immediately, without waiting for the server round-trip.
  // Updates BOTH the global store and the active project (child) store, since
  // use-providers.ts reads the child store when a project directory is open
  // (e.g. the AI chat model picker) — updating only the global store would
  // leave the in-project picker stale until a full refresh. The directory is
  // derived the same way use-providers.ts does (useParams + decode64).
  const removeFromConnected = (providerID: string) => {
    const next = globalSync.data.provider.connected.filter((id) => id !== providerID)
    globalSync.set("provider", "connected", next)
    const dir = currentDir()
    if (dir) {
      const [projectStore, setProjectStore] = globalSync.child(dir)
      if (projectStore.provider_ready) {
        const childNext = (projectStore.provider.connected ?? []).filter((id: string) => id !== providerID)
        setProjectStore("provider", "connected", childNext)
      }
    }
  }

  // Re-fetch the provider list from the server and update the store.
  // Mirrors the refresh pattern used in dialog-select-model.tsx.
  // When `refresh` is true the server re-probes local inference services,
  // so a framework started after launch (e.g. Ollama) shows up without a restart.
  const refreshConnectedProviders = async (refresh = false) => {
    try {
      const res = await globalSDK.client.provider.list(refresh ? { refresh: "true" } : undefined)
      if (res.data) {
        globalSync.set("provider", normalizeProviderList(res.data))
      }
    } catch {
      // Keep the optimistic state if the refresh fails (e.g. the global
      // instance was just disposed).
    }
  }

  // When the model tab opens, re-scan local inference services so a provider
  // that became reachable since launch (Ollama started, LM Studio launched,
  // etc.) appears immediately — no polling, just on open.
  onMount(() => {
    void refreshConnectedProviders(true)
  })

  const disableProvider = async (providerID: string): Promise<boolean> => {
    const before = globalSync.data.config.disabled_providers ?? []
    const next = before.includes(providerID) ? before : [...before, providerID]
    globalSync.set("config", "disabled_providers", next)

    try {
      await globalSync.updateConfig({ disabled_providers: next })
      return true
    } catch (err: unknown) {
      globalSync.set("config", "disabled_providers", before)
      throw err
    }
  }

  const disconnect = (providerID: string, name: string) => {
    // Disconnect deletes the stored API credentials for this provider — ask
    // before destroying them. Confirm-first also covers the custom-provider
    // path below (P4-7 keeps a failed credential delete from faking success).
    dialog.show(() => (
      <DialogConfirm
        danger
        busy={disconnectBusy()}
        title={language.t("settings.providers.disconnectConfirm.title")}
        message={language.t("settings.providers.disconnectConfirm.message", { provider: name })}
        confirmLabel={language.t("settings.providers.disconnectConfirm.confirm")}
        onConfirm={async () => {
          setDisconnectBusy(true)
          try {
            await performDisconnect(providerID, name)
          } finally {
            setDisconnectBusy(false)
          }
        }}
        onCancel={() => dialog.back()}
      />
    ))
  }

  const [disconnectBusy, setDisconnectBusy] = createSignal(false)

  const performDisconnect = async (providerID: string, name: string) => {
    try {
      if (isConfigCustom(providerID)) {
        await globalSDK.client.auth.remove({ providerID }).catch(() => undefined)
        await disableProvider(providerID)
      } else {
        await globalSDK.client.auth.remove({ providerID })
        // Rebuild the server instance (config.update does this on the server)
        // so the removed creds take effect. This mirrors disableProvider and the
        // custom-provider save path: updateConfig runs bootstrap() (which sets
        // bootingRoot and guards the async global.disposed refresh) so the screen
        // does not white-flash. removeFromConnected updates the UI reactively.
        await globalSync.updateConfig({})
      }
      // Optimistically drop the provider from the connected set so the row
      // disappears immediately. We intentionally do NOT re-fetch and overwrite
      // the provider store here: provider.list() can still return the stale
      // (pre-disconnect) state for a moment because auth.remove / global.dispose
      // propagate on the server side with a delay, which would re-add the row
      // until the settings dialog is reopened. The server-side change is already
      // applied above, so the next natural refresh reconciles correctly.
      removeFromConnected(providerID)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
        description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    }
  }

  // Remove a single model from a config provider
  const removeModel = async (providerID: string, modelID: string) => {
    const currentConfig = globalSync.data.config.provider?.[providerID]
    if (!currentConfig) return

    const updatedModels = { ...currentConfig.models }
    delete updatedModels[modelID]

    const updatedConfig = { ...currentConfig, models: updatedModels }

    await globalSync
      .updateConfig({ provider: { [providerID]: updatedConfig } })
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.providers.model.removed.title"),
          description: language.t("settings.providers.model.removed.description", { model: modelID }),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const addModel = async (
    providerID: string,
    modelID: string,
    name: string,
    contextStr: string,
    outputStr: string,
  ): Promise<boolean> => {
    const currentConfig = globalSync.data.config.provider?.[providerID]
    if (!currentConfig) return false

    const id = modelID.trim()
    if (!id) {
      showToast({ title: language.t("settings.providers.model.error.required") })
      return false
    }
    if (currentConfig.models?.[id]) {
      showToast({
        variant: "error",
        icon: "warning",
        title: language.t("settings.providers.model.error.exists"),
        description: language.t("settings.providers.model.error.exists.description", { model: id }),
      })
      return false
    }

    const context = contextStr ? parseInt(contextStr, 10) || 0 : 0
    const output = outputStr ? parseInt(outputStr, 10) || 0 : 0
    const updatedModels = {
      ...currentConfig.models,
      [id]: {
        name: name.trim() || id,
        ...(context > 0 || output > 0 ? { limit: { context, output } } : {}),
      },
    }
    const updatedConfig = { ...currentConfig, models: updatedModels }

    try {
      await globalSync.updateConfig({ provider: { [providerID]: updatedConfig } })
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.providers.model.added.title"),
        description: language.t("settings.providers.model.added.description", { model: id }),
      })
      return true
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
      return false
    }
  }

  // Format token count for display (e.g. 128000 → 128K, 2000000 → 2.0M)
  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
    return String(n)
  }

  const saveModelLimit = async (
    providerID: string,
    modelID: string,
    contextStr: string,
    outputStr: string,
    inputStr: string,
  ) => {
    const context = parseInt(contextStr, 10) || 0
    const output = parseInt(outputStr, 10) || 0
    const input = inputStr ? parseInt(inputStr, 10) || undefined : undefined
    const currentConfig = globalSync.data.config.provider?.[providerID]
    const currentModelConfig = currentConfig?.models?.[modelID] ?? {}
    const updatedModels = {
      ...currentConfig?.models,
      [modelID]: {
        ...currentModelConfig,
        limit: {
          context,
          output,
          ...(input !== undefined ? { input } : {}),
        },
      },
    }
    const updatedConfig = { ...currentConfig, models: updatedModels }
    try {
      await globalSync.updateConfig({ provider: { [providerID]: updatedConfig } })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: language.t("common.saveFailed"), description: message })
    }
  }

  // Search/filter for the model list within expanded providers
  const [filterText, setFilterText] = createSignal("")

  const filteredProviders = createMemo(() => {
    const filter = filterText().trim().toLowerCase()
    if (!filter) return connected()

    return connected().filter((p) => {
      // Match provider name/id
      if (p.name.toLowerCase().includes(filter) || p.id.toLowerCase().includes(filter)) return true
      // Match any model name/id under this provider
      const pModels = providerModels(p.id)
      return pModels.some((m) => m.name.toLowerCase().includes(filter) || m.id.toLowerCase().includes(filter))
    })
  })

  // LAN scan ports state
  const [customPorts, setCustomPorts] = createSignal(globalSync.data.config.lan_scan_ports ?? [])
  const [newPort, setNewPort] = createSignal("")
  const [portError, setPortError] = createSignal("")
  const defaultPorts = [11434, 1234, 8080, 8000, 23333, 30000]

  const addPort = async () => {
    const portNum = parseInt(newPort(), 10)
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setPortError(language.t("settings.providers.lanPorts.invalidPort"))
      return
    }
    if (defaultPorts.includes(portNum) || customPorts().includes(portNum)) {
      setPortError(language.t("settings.providers.lanPorts.duplicatePort"))
      return
    }
    const before = customPorts()
    const updated = [...before, portNum]
    setCustomPorts(updated)
    setNewPort("")
    setPortError("")
    try {
      await globalSync.updateConfig({ lan_scan_ports: updated } as any)
    } catch (err: unknown) {
      // Roll back the optimistic update and surface the failure.
      setCustomPorts(before)
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: language.t("common.saveFailed"), description: message })
    }
  }

  const removePort = async (port: number) => {
    const before = customPorts()
    const updated = before.filter((p) => p !== port)
    setCustomPorts(updated)
    try {
      await globalSync.updateConfig({ lan_scan_ports: updated } as any)
    } catch (err: unknown) {
      setCustomPorts(before)
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: language.t("common.saveFailed"), description: message })
    }
  }

  // Kobalte's DropdownMenu is modal: it owns a focus scope until its close
  // sequence fully completes (CSS exit animation ~140ms + DOM teardown).
  // The previous `setTimeout(show, 0)` only waited one macrotask — the menu's
  // focus scope was still alive when the new dialog opened, and on WKWebView
  // the dying menu scope and the new dialog's scope dead-looped over focus
  // (RangeError: Maximum call stack size exceeded, key dialog frozen).
  // Wait until the menu content is actually removed from the DOM instead of
  // guessing a timeout; the 2s cap guards against a menu that never unmounts.
  function showAfterMenuClose(show: () => void) {
    const started = performance.now()
    const tick = () => {
      if (
        !document.querySelector('[data-component="dropdown-menu-content"]') ||
        performance.now() - started > 2000
      ) {
        show()
      } else {
        requestAnimationFrame(tick)
      }
    }
    requestAnimationFrame(tick)
  }

  const deepseekConnected = createMemo(() => connected().some((p) => p.id === "deepseek"))

  return (
    <SettingsPage
      title={language.t("settings.providers.title")}
      toolbar={
        <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
          <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
          <TextField
            variant="ghost"
            type="text"
            value={filterText()}
            onChange={setFilterText}
            placeholder={language.t("dialog.model.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            class="flex-1"
          />
          <Show when={filterText()}>
            <IconButton icon="circle-x" variant="ghost" aria-label={language.t("ui.list.clearFilter")} onClick={() => setFilterText("")} />
          </Show>
        </div>
      }
    >
      <div class="flex flex-col gap-8">
        <div class="flex justify-end pb-2">
          {/* "Add model" offers a choice instead of jumping straight into the
              custom form: add a custom OpenAI-compatible model, or connect the
              built-in DeepSeek provider. Sub-dialogs are shown with
              dismiss="back" so their close button / Escape returns to this
              Settings dialog instead of tearing down the whole stack. */}
          <DropdownMenu placement="bottom-end">
            <DropdownMenu.Trigger as={Button} size="small" variant="secondary" icon="plus-small">
              {language.t("command.provider.connect")}
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="mt-1">
                <DropdownMenu.Item
                  onSelect={() => showAfterMenuClose(() => dialog.show(() => <DialogCustomProvider back="close" preset="custom" />, undefined, "back"))}
                >
                  <DropdownMenu.ItemLabel>{language.t("settings.providers.add.custom")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                {/* Only one DeepSeek provider can exist (it is built-in), so
                    once it is connected there is nothing left to add. */}
                <DropdownMenu.Item
                  disabled={deepseekConnected()}
                  onSelect={() => showAfterMenuClose(() => dialog.show(() => <DialogConnectProvider provider="deepseek" />, undefined, "back"))}
                >
                  <DropdownMenu.ItemLabel>{language.t("settings.providers.add.deepseek")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>

        {/* LAN Scan Ports */}
        <div class="flex flex-col gap-2" data-component="lan-scan-ports">
          <h3 class="text-14-medium text-text-strong pb-1">{language.t("settings.providers.lanPorts.title")}</h3>
          <div class="text-13-regular text-text-weak">
            {language.t("settings.providers.lanPorts.defaultPorts")}: {defaultPorts.join(", ")}
          </div>
          <Show when={customPorts().length > 0}>
            <div class="flex flex-wrap gap-1.5">
              <For each={customPorts()}>
                {(port) => (
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-base text-13-regular text-text-base">
                    {port}
                    <button
                      class="text-icon-weak-base hover:text-icon-strong-base"
                      onClick={() => void removePort(port)}
                    >
                      <Icon name="circle-x" class="size-3.5" />
                    </button>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <div class="flex items-center gap-2">
            <TextField
              variant="normal"
              type="number"
              value={newPort()}
              onChange={setNewPort}
              placeholder={language.t("settings.providers.lanPorts.addPlaceholder")}
              class="w-32"
            />
            <Button size="small" variant="secondary" onClick={() => void addPort()}>
              {language.t("settings.providers.lanPorts.addButton")}
            </Button>
          </div>
          <Show when={portError()}>
            <div class="text-13-regular text-text-on-critical-base">{portError()}</div>
          </Show>
        </div>

        {/* Connected providers with expandable model lists */}
        <div class="flex flex-col gap-1" data-component="connected-providers-section">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.providers.section.connected")}</h3>
          <Show
            when={filteredProviders().length > 0}
            fallback={
              <div class="py-4 text-14-regular text-text-weak">{language.t("settings.providers.connected.empty")}</div>
            }
          >
            <SettingsList>
              <For each={filteredProviders()}>
                {(item) => {
                  const isExpanded = createMemo(() => expanded().has(item.id))
                  const pModels = createMemo(() => providerModels(item.id))
                  const modelCount = createMemo(() => pModels().length)
                  // Model add/remove only applies to config-defined providers.
                  // A built-in provider ignores model edits server-side (only
                  // per-model limit overrides are honored), so hide the buttons.
                  const canRemoveModels = isConfigProvider(item.id) && !isBuiltinProvider(item.id)

                  // Inline "add model" form state for this provider
                  const [showAddModel, setShowAddModel] = createSignal(false)
                  const [newModelID, setNewModelID] = createSignal("")
                  const [newModelName, setNewModelName] = createSignal("")
                  const [newContextLimit, setNewContextLimit] = createSignal("")
                  const [newOutputLimit, setNewOutputLimit] = createSignal("")
                  const resetAddModel = () => {
                    setNewModelID("")
                    setNewModelName("")
                    setNewContextLimit("")
                    setNewOutputLimit("")
                  }

                  return (
                    <div class="border-b border-border-weak-base last:border-none">
                      {/* Provider row */}
                      <div class="group flex flex-wrap items-center justify-between gap-4 min-h-16 py-3">
                        <div
                          class="flex items-center gap-3 min-w-0 cursor-pointer"
                          onClick={() => toggleExpand(item.id)}
                        >
                          <IconButton
                            icon={isExpanded() ? "chevron-down" : "chevron-right"}
                            variant="ghost"
                            class="size-5 -ml-1"
                            aria-label={isExpanded() ? "Collapse" : "Expand"}
                          />
                          <Icon name="providers" class="size-5 shrink-0 icon-strong-base" />
                          <span class="text-14-medium text-text-strong truncate">{item.name}</span>
                          <Tag>{type(item)}</Tag>
                          <Show when={source(item) === "api" && keyringProviders().has(item.id ?? "")}>
                            <Tag>🔒 {language.t("settings.providers.tag.secure")}</Tag>
                          </Show>
                          <span class="text-12-regular text-text-weak">
                            {modelCount()} {modelCount() === 1 ? "model" : "models"}
                          </span>
                        </div>
                        <Show
                          when={canDisconnect(item)}
                          fallback={
                            <span class="text-14-regular text-text-base opacity-0 group-hover:opacity-100 transition-opacity duration-200 pr-3 cursor-default">
                              {language.t("settings.providers.connected.environmentDescription")}
                            </span>
                          }
                        >
                          <Show when={isConfigCustom(item.id) || isBuiltinProvider(item.id)}>
                            <IconButton
                              icon="edit"
                              variant="ghost"
                              class="size-7"
                              aria-label={language.t("provider.custom.edit")}
                              onClick={() =>
                                isBuiltinProvider(item.id)
                                  ? dialog.show(
                                      () => (
                                        <DialogEditBuiltinProvider
                                          providerID={item.id}
                                          name={item.name}
                                        />
                                      ),
                                      undefined,
                                      "back",
                                    )
                                  : dialog.show(
                                      () => <DialogCustomProvider back="close" editProviderID={item.id} />,
                                      undefined,
                                      "back",
                                    )
                              }
                            />
                          </Show>
                          <Button size="large" variant="ghost" onClick={() => void disconnect(item.id, item.name)}>
                            {language.t("common.disconnect")}
                          </Button>
                        </Show>
                      </div>

                      {/* Expandable model list */}
                      <Show when={isExpanded()}>
                        <div class="pl-12 pr-2 pb-3 flex flex-col gap-0.5">
                          <Show
                            when={pModels().length > 0}
                            fallback={
                              <div class="py-2 text-13-regular text-text-weak">{language.t("dialog.model.empty")}</div>
                            }
                          >
                            <For each={pModels()}>
                              {(model) => (
                                <ModelRow
                                  model={model}
                                  providerID={item.id}
                                  canRemoveModels={canRemoveModels}
                                  editable={isConfigCustom(item.id)}
                                  formatTokens={formatTokens}
                                  saveModelLimit={saveModelLimit}
                                  removeModel={removeModel}
                                />
                              )}
                            </For>
                          </Show>
                          <Show when={canRemoveModels}>
                            <Show when={showAddModel()}>
                              <div class="mt-2 p-3 rounded-md bg-surface-raised-base border border-border-weak-base flex flex-col gap-2">
                                <div class="flex items-center gap-3">
                                  <label class="text-12-regular text-text-weak w-28 shrink-0">
                                    {language.t("provider.custom.models.id.label")}
                                  </label>
                                  <input
                                    class="flex-1 min-w-0 px-2 py-1 text-13-regular bg-surface-base border border-border-weak-base rounded-md outline-none focus:border-accent-base"
                                    placeholder={language.t("provider.custom.models.id.placeholder")}
                                    value={newModelID()}
                                    onInput={(e) => setNewModelID(e.currentTarget.value)}
                                  />
                                </div>
                                <div class="flex items-center gap-3">
                                  <label class="text-12-regular text-text-weak w-28 shrink-0">
                                    {language.t("settings.providers.model.name")}
                                  </label>
                                  <input
                                    class="flex-1 min-w-0 px-2 py-1 text-13-regular bg-surface-base border border-border-weak-base rounded-md outline-none focus:border-accent-base"
                                    placeholder={language.t("settings.providers.model.name.placeholder")}
                                    value={newModelName()}
                                    onInput={(e) => setNewModelName(e.currentTarget.value)}
                                  />
                                </div>
                                <div class="flex items-center gap-3">
                                  <label class="text-12-regular text-text-weak w-28 shrink-0">
                                    {language.t("settings.providers.model.contextLimit")}
                                  </label>
                                  <input
                                    type="number"
                                    class="flex-1 min-w-0 px-2 py-1 text-13-regular bg-surface-base border border-border-weak-base rounded-md outline-none focus:border-accent-base"
                                    value={newContextLimit()}
                                    onInput={(e) => setNewContextLimit(e.currentTarget.value)}
                                  />
                                </div>
                                <div class="flex items-center gap-3">
                                  <label class="text-12-regular text-text-weak w-28 shrink-0">
                                    {language.t("settings.providers.model.outputLimit")}
                                  </label>
                                  <input
                                    type="number"
                                    class="flex-1 min-w-0 px-2 py-1 text-13-regular bg-surface-base border border-border-weak-base rounded-md outline-none focus:border-accent-base"
                                    value={newOutputLimit()}
                                    onInput={(e) => setNewOutputLimit(e.currentTarget.value)}
                                  />
                                </div>
                                <div class="flex justify-end gap-2 mt-1">
                                  <Button
                                    size="small"
                                    variant="secondary"
                                    onClick={() => {
                                      setShowAddModel(false)
                                      resetAddModel()
                                    }}
                                  >
                                    {language.t("settings.providers.model.cancel")}
                                  </Button>
                                  <Button
                                    size="small"
                                    variant="primary"
                                    onClick={() => {
                                      void addModel(
                                        item.id,
                                        newModelID(),
                                        newModelName(),
                                        newContextLimit(),
                                        newOutputLimit(),
                                      ).then((ok) => {
                                        if (!ok) return
                                        resetAddModel()
                                        setShowAddModel(false)
                                      })
                                    }}
                                  >
                                    {language.t("common.submit")}
                                  </Button>
                                </div>
                              </div>
                            </Show>
                            <Show when={!showAddModel()}>
                              <Button
                                type="button"
                                size="small"
                                variant="ghost"
                                icon="plus-small"
                                onClick={() => setShowAddModel(true)}
                                class="self-start mt-1"
                              >
                                {language.t("provider.custom.models.add")}
                              </Button>
                            </Show>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </SettingsList>
          </Show>
        </div>
      </div>
    </SettingsPage>
  )
}
