import { Button } from "@duoduo-ai/ui/button"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Icon } from "@duoduo-ai/ui/icon"
import { Switch } from "@duoduo-ai/ui/switch"
import { Tabs } from "@duoduo-ai/ui/tabs"
import { useMutation } from "@tanstack/solid-query"
import { showToast } from "@duoduo-ai/ui/toast"
import { useNavigate } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { gearList, refreshGears } from "@/context/gear-store"
import { useSmartLayer } from "@/addons/smart-layer/context"
import { useCheckServerHealth, type ServerHealth } from "@/utils/server-health"

const pollMs = 10_000

const listServersByHealth = (
  list: ServerConnection.Any[],
  active: ServerConnection.Key | undefined,
  status: Record<ServerConnection.Key, ServerHealth | undefined>,
) => {
  if (!list.length) return list
  const order = new Map(list.map((url, index) => [url, index] as const))
  const rank = (value?: ServerHealth) => {
    if (value?.healthy === true) return 0
    if (value?.healthy === false) return 2
    return 1
  }

  return list.slice().sort((a, b) => {
    if (ServerConnection.key(a) === active) return -1
    if (ServerConnection.key(b) === active) return 1
    const diff = rank(status[ServerConnection.key(a)]) - rank(status[ServerConnection.key(b)])
    if (diff !== 0) return diff
    return (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, enabled: Accessor<boolean>) => {
  const checkServerHealth = useCheckServerHealth()
  const [status, setStatus] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)

  createEffect(() => {
    if (!enabled()) {
      setStatus(reconcile({}))
      return
    }
    const list = servers()
    let dead = false

    const refresh = async () => {
      const results: Record<string, ServerHealth> = {}
      await Promise.all(
        list.map(async (conn) => {
          results[ServerConnection.key(conn)] = await checkServerHealth(conn.http)
        }),
      )
      if (dead) return
      setStatus(reconcile(results))
    }

    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return status
}

const useDefaultServerKey = (
  get: (() => string | Promise<string | null | undefined> | null | undefined) | undefined,
) => {
  const [state, setState] = createStore({
    url: undefined as string | undefined,
    tick: 0,
  })

  createEffect(() => {
    state.tick
    let dead = false
    const result = get?.()
    if (!result) {
      setState("url", undefined)
      onCleanup(() => {
        dead = true
      })
      return
    }

    if (result instanceof Promise) {
      void result.then((next) => {
        if (dead) return
        setState("url", next ? normalizeServerUrl(next) : undefined)
      })
      onCleanup(() => {
        dead = true
      })
      return
    }

    setState("url", normalizeServerUrl(result))
    onCleanup(() => {
      dead = true
    })
  })

  return {
    key: () => {
      const u = state.url
      if (!u) return
      return ServerConnection.key({ type: "http", http: { url: u } })
    },
    refresh: () => setState("tick", (value) => value + 1),
  }
}

const useMcpToggleMutation = () => {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()

  return useMutation(() => ({
    mutationFn: async (name: string) => {
      const status = sync.data.mcp[name]
      await (status?.status === "connected" ? sdk.client.mcp.disconnect({ name }) : sdk.client.mcp.connect({ name }))
      const result = await sdk.client.mcp.status()
      if (result.data) sync.set("mcp", result.data)
    },
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    },
  }))
}

export function StatusPopoverBody(props: { shown: Accessor<boolean> }) {
  const sync = useSync()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const sdk = useSDK()
  const sl = useSmartLayer()

  const [load, setLoad] = createStore({
    lspDone: false,
    lspLoading: false,
    mcpDone: false,
    mcpLoading: false,
  })

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: err instanceof Error ? err.message : String(err),
    })
  }

  createEffect(() => {
    if (!props.shown()) return

    void refreshGears()

    if (!sync.data.mcp_ready && !load.mcpDone && !load.mcpLoading) {
      setLoad("mcpLoading", true)
      void sdk.client.mcp
        .status()
        .then((result) => {
          sync.set("mcp", result.data ?? {})
          sync.set("mcp_ready", true)
        })
        .catch((err) => {
          setLoad("mcpDone", true)
          fail(err)
        })
        .finally(() => {
          setLoad("mcpLoading", false)
        })
    }

    if (!sync.data.lsp_ready && !load.lspDone && !load.lspLoading) {
      setLoad("lspLoading", true)
      void sdk.client.lsp
        .status()
        .then((result) => {
          sync.set("lsp", result.data ?? [])
          sync.set("lsp_ready", true)
          if (!(result.data ?? []).some((s) => s.status === "error")) sync.set("lsp_warming", false)
        })
        .catch((err) => {
          setLoad("lspDone", true)
          fail(err)
        })
        .finally(() => {
          setLoad("lspLoading", false)
        })
    }
  })

  let dialogRun = 0
  let dialogDead = false
  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
  })
  const servers = createMemo(() => {
    const current = server.current
    const list = server.list
    if (!current) return list
    if (list.every((item) => ServerConnection.key(item) !== ServerConnection.key(current))) return [current, ...list]
    return [current, ...list.filter((item) => ServerConnection.key(item) !== ServerConnection.key(current))]
  })
  const health = useServerHealth(servers, props.shown)
  const sortedServers = createMemo(() => listServersByHealth(servers(), server.key, health))
  const toggleMcp = useMcpToggleMutation()
  // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
  const defaultServer = useDefaultServerKey(platform.getDefaultServer)
  const mcpNames = createMemo(() => Object.keys(sync.data.mcp ?? {}).sort((a, b) => a.localeCompare(b)))
  const mcpStatus = (name: string) => sync.data.mcp?.[name]?.status
  const lspItems = createMemo(() => sync.data.lsp ?? [])
  const lspCount = createMemo(() => lspItems().length)
  const plugins = createMemo(() =>
    (sync.data.config.plugin ?? []).map((item) => (typeof item === "string" ? item : item[0])),
  )
  const skillGears = createMemo(() =>
    gearList().filter((g) => (g.kind === "skill" || g.kind === "native") && g.enabled !== false),
  )
  const gearItemCount = createMemo(
    () => mcpNames().length + plugins().length + skillGears().length,
  )

  return (
    <div class="flex items-center gap-1 w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]">
      <Tabs
        aria-label={language.t("status.popover.ariaLabel")}
        class="tabs bg-background-strong rounded-xl overflow-hidden"
        data-component="tabs"
        data-active="servers"
        defaultValue="servers"
        variant="alt"
      >
        <Tabs.List data-slot="tablist" class="bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10">
          <Tabs.Trigger value="servers" data-slot="tab" class="text-12-regular">
            {sortedServers().length > 0 ? `${sortedServers().length} ` : ""}
            {language.t("status.popover.tab.servers")}
          </Tabs.Trigger>
          <Tabs.Trigger value="gear" data-slot="tab" class="text-12-regular">
            {gearItemCount() > 0 ? `${gearItemCount()} ` : ""}
            {language.t("status.popover.tab.gear")}
          </Tabs.Trigger>
          <Tabs.Trigger value="lsp" data-slot="tab" class="text-12-regular">
            {lspCount() > 0 ? `${lspCount()} ` : ""}
            {language.t("status.popover.tab.lsp")}
          </Tabs.Trigger>
          <Tabs.Trigger value="smartlayer" data-slot="tab" class="text-12-regular">
            {language.t("smartLayer.label")}
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="servers">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
              <For each={sortedServers()}>
                {(s) => {
                  const key = ServerConnection.key(s)
                  const blocked = () => health[key]?.healthy === false
                  return (
                    <button
                      type="button"
                      class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md transition-colors text-left"
                      classList={{
                        "hover:bg-surface-raised-base-hover": !blocked(),
                        "cursor-not-allowed": blocked(),
                      }}
                      aria-disabled={blocked()}
                      onClick={() => {
                        if (blocked()) return
                        navigate("/")
                        queueMicrotask(() => server.setActive(key))
                      }}
                    >
                      <ServerHealthIndicator health={health[key]} />
                      <ServerRow
                        conn={s}
                        dimmed={blocked()}
                        status={health[key]}
                        class="flex items-center gap-2 w-full min-w-0"
                        nameClass="text-14-regular text-text-base truncate"
                        versionClass="text-12-regular text-text-weak truncate"
                        badge={
                          <Show when={key === defaultServer.key()}>
                            <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                              {language.t("common.default")}
                            </span>
                          </Show>
                        }
                      >
                        <div class="flex-1" />
                        <Show when={server.current && key === ServerConnection.key(server.current)}>
                          <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                        </Show>
                      </ServerRow>
                    </button>
                  )
                }}
              </For>

              <Button
                variant="secondary"
                class="mt-3 self-start h-8 px-3 py-1.5"
                onClick={() => {
                  const run = ++dialogRun
                  void import("./dialog-select-server").then((x) => {
                    if (dialogDead || dialogRun !== run) return
                    dialog.show(() => <x.DialogSelectServer />, defaultServer.refresh)
                  })
                }}
              >
                {language.t("status.popover.action.manageServers")}
              </Button>
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="gear">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
              <Show
                when={mcpNames().length === 0 && plugins().length === 0 && skillGears().length === 0}
                fallback={
                  <>
                    <Show when={mcpNames().length > 0}>
                      <For each={mcpNames()}>
                        {(name) => {
                          const status = () => mcpStatus(name)
                          const enabled = () => status() === "connected"
                          return (
                            <button
                              type="button"
                              class="flex items-center gap-2 w-full h-8 pl-3 pr-2 py-1 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                              onClick={() => {
                                if (toggleMcp.isPending) return
                                toggleMcp.mutate(name)
                              }}
                              disabled={toggleMcp.isPending && toggleMcp.variables === name}
                            >
                              <div
                                classList={{
                                  "size-1.5 rounded-full shrink-0": true,
                                  "bg-icon-success-base": status() === "connected",
                                  "bg-icon-critical-base": status() === "failed",
                                  "bg-border-weak-base": status() === "disabled",
                                  "bg-icon-warning-base":
                                    status() === "needs_auth" || status() === "needs_client_registration",
                                }}
                              />
                              <span class="text-14-regular text-text-base truncate flex-1">{name}</span>
                              <div onClick={(event) => event.stopPropagation()}>
                                <Switch
                                  checked={enabled()}
                                  disabled={toggleMcp.isPending && toggleMcp.variables === name}
                                  onChange={() => {
                                    if (toggleMcp.isPending) return
                                    toggleMcp.mutate(name)
                                  }}
                                />
                              </div>
                            </button>
                          )
                        }}
                      </For>
                    </Show>
                    <Show when={plugins().length > 0}>
                      <div
                        classList={{
                          "border-t border-surface-raised-base mt-1 pt-1": mcpNames().length > 0,
                        }}
                      >
                        <For each={plugins()}>
                          {(plugin) => (
                            <div class="flex items-center gap-2 w-full px-2 py-1">
                              <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                              <span class="text-14-regular text-text-base truncate">{plugin}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show when={skillGears().length > 0}>
                      <div
                        classList={{
                          "border-t border-surface-raised-base mt-1 pt-1":
                            mcpNames().length > 0 || plugins().length > 0,
                        }}
                      >
                        <For each={skillGears()}>
                          {(gear) => (
                            <div class="flex items-center gap-2 w-full px-2 py-1">
                              <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                              <span class="text-14-regular text-text-base truncate">{gear.name}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </>
                }
              >
                <div class="text-14-regular text-text-base text-center my-auto">{language.t("dialog.gear.empty")}</div>
              </Show>
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="lsp">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
              <Show
                when={lspItems().length > 0}
                fallback={
                  <div class="text-14-regular text-text-base text-center my-auto">{language.t("dialog.lsp.empty")}</div>
                }
              >
                <For each={lspItems()}>
                  {(item) => (
                    <div class="flex items-center gap-2 w-full px-2 py-1">
                      <div
                        classList={{
                          "size-1.5 rounded-full shrink-0": true,
                          "bg-icon-success-base": item.status === "connected",
                          "bg-icon-critical-base": item.status === "error",
                        }}
                      />
                      <span class="text-14-regular text-text-base truncate">{item.name || item.id}</span>
                      <Show when={item.status === "error"}>
                        <button
                          type="button"
                          class="ml-auto text-12-regular text-text-weak hover:text-text-base cursor-pointer"
                          onClick={() => {
                            void (sdk.client.lsp as any).client
                              .post({ url: "/lsp/retry", body: { root: item.root, id: item.id } })
                              .then(() => {
                                sync.set("lsp_ready", false)
                                // 回到 warming 态：指示器转 spinner，直到事件推送终态
                                sync.set("lsp_warming", true)
                              })
                              .catch(() => {})
                          }}
                        >
                          {language.t("status.popover.lsp.retry")}
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="smartlayer">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14 gap-3">
              <div class="flex items-center gap-2">
                <div
                  classList={{
                    "size-1.5 rounded-full shrink-0": true,
                    "bg-icon-success-base": sl.status === "connected",
                    "bg-icon-critical-base": sl.status === "disconnected",
                    "bg-border-weak-base": sl.status !== "connected" && sl.status !== "disconnected",
                  }}
                />
                <span class="text-14-regular text-text-base">
                  {sl.status === "connected"
                    ? language.t("smartLayer.status.connected")
                    : sl.status === "disconnected"
                      ? language.t("smartLayer.status.disconnected")
                      : language.t("smartLayer.status.checking")}
                </span>
              </div>
              <Show when={sl.status !== "connected"}>
                <Button variant="secondary" class="self-start h-8 px-3 py-1.5" onClick={() => sl.checkHealth()}>
                  {language.t("smartLayer.retry")}
                </Button>
              </Show>
            </div>
          </div>
        </Tabs.Content>

      </Tabs>
    </div>
  )
}
