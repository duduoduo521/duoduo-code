import { useMutation, useQuery } from "@tanstack/solid-query"
import { Component, createMemo, createSignal, Show } from "solid-js"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { useSmartLayer } from "@/addons/smart-layer/context"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { List } from "@duoduo-ai/ui/list"
import { Switch } from "@duoduo-ai/ui/switch"
import { showToast } from "@duoduo-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { refreshGears } from "@/context/gear-store"

/**
 * IntelGear (智械) capability selector.
 * Lists all installed gears (native + MCP + skill + plugin) with:
 *   - enable/disable toggle (per gear)
 *   - an auto-call selector (activation: command | auto | global)
 *   - a "install from local folder" entry
 *
 * Backed by the unified `/gears` routes (list/enable/disable/activation/install).
 */

type Activation = "command" | "auto" | "global"

type GearItem = {
  id: string
  name: string
  /** Human-friendly title from the marketplace; falls back to `name`. */
  display_name?: string | null
  version?: string
  kind: "native" | "mcp" | "skill" | "plugin"
  activation: Activation
  enabled: boolean
  status?: string
}

type GearListResp = Array<{
  id?: string
  name: string
  display_name?: string | null
  version?: string
  kind?: string
  activation?: string
  enabled?: boolean
}>

export const DialogSelectGear: Component = () => {
  const sdk = useSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const sl = useSmartLayer()
  const [installing, setInstalling] = createSignal(false)

  // ── Unified gear API helpers (desktop: smart-layer client; web dev: Vite proxy) ──
  async function gearGet<T>(path: string): Promise<T> {
    const api = sl.api
    if (api) return api.get<T>(path)
    const resp = await fetch(path)
    if (!resp.ok) throw new Error(`GET ${path}: ${resp.status}`)
    return resp.json() as Promise<T>
  }

  async function gearPost<T>(path: string, body?: unknown): Promise<T> {
    const api = sl.api
    if (api) return api.post<T>(path, body)
    const resp = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!resp.ok) throw new Error(`POST ${path}: ${resp.status}`)
    return resp.json() as Promise<T>
  }

  async function gearPatch<T>(path: string, body?: unknown): Promise<T> {
    const api = sl.api
    if (api) return api.patch<T>(path, body)
    const resp = await fetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!resp.ok) throw new Error(`PATCH ${path}: ${resp.status}`)
    return resp.json() as Promise<T>
  }

  // Fetch gears list from /gears endpoint (now carries kind/activation/enabled).
  const gearsQuery = useQuery(() => ({
    queryKey: ["gears"],
    queryFn: () => gearGet<GearListResp>("/gears"),
  }))

  // Fetch MCP status for connection info (overlay onto mcp-kind gears).
  const mcpQuery = useQuery(() => ({
    queryKey: ["mcp-status"],
    queryFn: async () => {
      const result = await sdk.client.mcp.status()
      return result.data ?? {}
    },
  }))

  const normalizeKind = (k?: string): GearItem["kind"] => {
    switch (k) {
      case "mcp":
      case "skill":
      case "plugin":
        return k
      default:
        return "native"
    }
  }

  const normalizeActivation = (a?: string): Activation => {
    switch (a) {
      case "auto":
      case "global":
        return a
      default:
        return "command"
    }
  }

  const items = createMemo<GearItem[]>(() => {
    const gears = gearsQuery.data ?? []
    const mcp = mcpQuery.data ?? {}
    const result: GearItem[] = []

    for (const g of gears) {
      const mcpStatus = mcp[g.name]
      const kind = normalizeKind(g.kind)
      result.push({
        id: g.id ?? g.name,
        name: g.name,
        display_name: g.display_name,
        version: g.version,
        kind,
        activation: normalizeActivation(g.activation),
        // MCP gears reflect live connection state; others use the stored enabled flag.
        enabled: kind === "mcp" && mcpStatus ? mcpStatus.status === "connected" : g.enabled ?? true,
        status: mcpStatus?.status,
      })
    }

    // Add MCP servers not already represented as gears.
    for (const [name, status] of Object.entries(mcp) as [string, { status: string }][]) {
      if (!result.some((g) => g.name === name)) {
        result.push({
          id: name,
          name,
          kind: "mcp",
          activation: "auto",
          enabled: status.status === "connected",
          status: status.status,
        })
      }
    }

    return result.sort((a, b) => a.name.localeCompare(b.name))
  })

  // Toggle enable/disable. MCP uses connect/disconnect; others hit /gears/:name/(enable|disable).
  const toggle = useMutation(() => ({
    mutationFn: async (item: GearItem) => {
      if (item.kind === "mcp") {
        if (item.enabled) {
          await sdk.client.mcp.disconnect({ name: item.name })
        } else {
          await sdk.client.mcp.connect({ name: item.name })
        }
        await mcpQuery.refetch()
        return
      }
      const action = item.enabled ? "disable" : "enable"
      await gearPost(`/gears/${encodeURIComponent(item.name)}/${action}`)
      await gearsQuery.refetch()
      await refreshGears(true)
    },
    onError: (err) => showToast({ title: String(err), variant: "error" }),
  }))

  // Change activation (the "auto-call" selector): PATCH /gears/:name/activation.
  const changeActivation = useMutation(() => ({
    mutationFn: async (input: { item: GearItem; activation: Activation }) => {
      await gearPatch(`/gears/${encodeURIComponent(input.item.name)}/activation`, {
        activation: input.activation,
      })
      await gearsQuery.refetch()
      await refreshGears(true)
    },
    onError: (err) => showToast({ title: String(err), variant: "error" }),
  }))

  // Install from a local folder. Prompts the user to pick a directory, then lets
  // them choose the auto-call policy at install time (per the "user decides" model).
  const installLocal = async () => {
    if (installing()) return
    if (!platform.openDirectoryPickerDialog) {
      showToast({ title: language.t("dialog.gear.install.pickFolder"), variant: "error" })
      return
    }
    setInstalling(true)
    try {
      const picked = await platform
        .openDirectoryPickerDialog({ title: language.t("dialog.gear.install.pickFolder") })
        .catch(() => null)
      const dir = Array.isArray(picked) ? picked[0] : picked
      if (!dir) {
        setInstalling(false)
        return
      }
      // activation omitted → backend uses the manifest's declared policy.
      await gearPost("/gears/install", { path: dir })
      showToast({ title: language.t("dialog.gear.install.success"), variant: "success" })
      await gearsQuery.refetch()
      await refreshGears(true)
    } catch (err) {
      showToast({ title: String(err), variant: "error" })
    } finally {
      setInstalling(false)
    }
  }

  const enabledCount = createMemo(() => items().filter((i) => i.enabled).length)
  const totalCount = createMemo(() => items().length)

  const kindIcon = (kind: string) => {
    switch (kind) {
      case "mcp":
        return "🔌"
      case "skill":
        return "📝"
      case "plugin":
        return "🧩"
      default:
        return "⚙️"
    }
  }

  const activationLabel = (a: Activation) => {
    switch (a) {
      case "auto":
        return language.t("dialog.gear.activation.auto")
      case "global":
        return language.t("dialog.gear.activation.global")
      default:
        return language.t("dialog.gear.activation.command")
    }
  }

  const cycleActivation = (a: Activation): Activation =>
    a === "command" ? "auto" : a === "auto" ? "global" : "command"

  return (
    <Dialog
      title={language.t("dialog.gear.title")}
      description={language.t("dialog.gear.description", { enabled: enabledCount(), total: totalCount() })}
    >
      <div class="mb-2 flex justify-end">
        <button
          type="button"
          class="text-12-regular px-2 py-1 rounded bg-surface-weak hover:bg-surface-weaker disabled:opacity-50"
          disabled={installing()}
          onClick={() => void installLocal()}
        >
          {installing()
            ? language.t("common.loading.ellipsis")
            : language.t("dialog.gear.install.local")}
        </button>
      </div>
      <List
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.gear.empty")}
        key={(x) => x?.id ?? x?.name ?? ""}
        items={items}
        filterKeys={["name", "kind", "status"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        onSelect={(x) => {
          if (!x || toggle.isPending) return
          toggle.mutate(x)
        }}
      >
        {(i) => {
          const isPending = () => toggle.isPending && toggle.variables?.name === i.name
          const isActivationPending = () =>
            changeActivation.isPending && changeActivation.variables?.item.name === i.name
          return (
            <div class="w-full flex items-center justify-between gap-x-3">
              <div class="flex flex-col gap-0.5 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-12-regular">{kindIcon(i.kind)}</span>
                  <span class="truncate">{i.display_name || i.name}</span>
                  <Show when={i.version}>
                    <span class="text-11-regular text-text-weaker">v{i.version}</span>
                  </Show>
                  <span class="text-11-regular text-text-weaker uppercase">{i.kind}</span>
                  <Show when={isPending()}>
                    <span class="text-11-regular text-text-weak">{language.t("common.loading.ellipsis")}</span>
                  </Show>
                </div>
                <Show when={i.status && i.status !== "connected"}>
                  <span class="text-11-regular text-text-weaker">{i.status}</span>
                </Show>
              </div>
              <div class="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                {/* Auto-call selector: click to cycle command → auto → global. MCP has no activation. */}
                <Show when={i.kind !== "mcp"}>
                  <button
                    type="button"
                    class="text-11-regular px-1.5 py-0.5 rounded bg-surface-weak hover:bg-surface-weaker disabled:opacity-50"
                    title={language.t("dialog.gear.activation.hint")}
                    disabled={isActivationPending()}
                    onClick={() =>
                      changeActivation.mutate({ item: i, activation: cycleActivation(i.activation) })
                    }
                  >
                    {activationLabel(i.activation)}
                  </button>
                </Show>
                <Switch
                  checked={i.enabled}
                  disabled={isPending()}
                  onChange={() => {
                    if (toggle.isPending) return
                    toggle.mutate(i)
                  }}
                />
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
