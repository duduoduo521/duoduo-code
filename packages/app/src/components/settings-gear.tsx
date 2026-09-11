import { Component, Show, For, createSignal, onMount } from "solid-js"
import { Button } from "@duoduo-ai/ui/button"
import { TextField } from "@duoduo-ai/ui/text-field"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Switch } from "@duoduo-ai/ui/switch"
import { showToast } from "@duoduo-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useSmartLayer } from "@/addons/smart-layer/context"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { SettingsList } from "./settings-list"
import { SettingsPage } from "./settings-page"
import { DialogConfirm } from "./dialog-confirm"

interface GearCapabilities {
  instructions: boolean
  tools: string[]
  strategies: string[]
}

interface GearInfo {
  id: string
  name: string
  /** Human-friendly title from the marketplace; falls back to `name`.
   * The backend serializes camelCase (`displayName`); `display_name` is kept
   * as a defensive fallback for any snake_case source. */
  displayName?: string | null
  display_name?: string | null
  /** Marketplace spec this gear was installed from, e.g.
   * `modelscope:Alipay/alipay-subscription`; the UI shows its id as a subtitle. */
  spec?: string | null
  version: string
  description: string
  kind: string
  activation: string
  enabled: boolean
  license?: string | null
  hasInstructions: boolean
  capabilities?: GearCapabilities
}

export const SettingsGear: Component = () => {
  const language = useLanguage()
  const sl = useSmartLayer()
  const dialog = useDialog()

  async function gearRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const api = sl.api
    if (api) {
      if (method === "GET") return api.get<T>(path)
      if (method === "POST") return api.post<T>(path, body)
      if (method === "DELETE") return api.del<T>(path)
    }
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as Record<string, any>
      throw new Error(e?.error ?? res.statusText)
    }
    return res.json() as Promise<T>
  }

  // ── installed gears ──
  const [gears, setGears] = createSignal<GearInfo[]>([])
  const [loading, setLoading] = createSignal(false)

  // ── remote gear (MCP over SSE) form ──
  const [mcpName, setMcpName] = createSignal("")
  const [mcpUrl, setMcpUrl] = createSignal("")
  const [mcpDesc, setMcpDesc] = createSignal("")
  // Re-entrancy guard: prevents double-submit of the MCP form (e.g. via
  // rapid clicks or Enter key) which would create duplicate gears.
  const [mcpSubmitting, setMcpSubmitting] = createSignal(false)

  // ── custom gear data directory ──
  const [gearDataDir, setGearDataDir] = createSignal("")
  const [pathSaved, setPathSaved] = createSignal(false)
  const [pathError, setPathError] = createSignal("")

  const tauriInvoke = (cmd: string, args?: Record<string, unknown>) =>
    (window as unknown as { __TAURI__?: { core?: { invoke?: (c: string, a?: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__?.core?.invoke?.(cmd, args)

  const loadGearDataDir = async () => {
    try {
      const dir = await tauriInvoke("get_gear_data_dir")
      if (typeof dir === "string") setGearDataDir(dir)
    } catch {
      /* ignore */
    }
  }

  const loadGears = async () => {
    setLoading(true)
    try {
      const data = await gearRequest<GearInfo[]>("GET", "/gears")
      setGears(data ?? [])
    } catch (e: any) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: e?.message,
      })
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void loadGears()
    void loadGearDataDir()
  })

  const capabilityTags = (g: GearInfo): string[] => {
    const tags: string[] = []
    if (g.hasInstructions || g.capabilities?.instructions) {
      tags.push(language.t("settings.gear.cap.instructions"))
    }
    if (g.kind === "mcp") {
      tags.push(language.t("settings.gear.cap.mcp"))
    }
    for (const t of g.capabilities?.tools ?? []) {
      if (t !== "mcp") tags.push(t)
    }
    for (const s of g.capabilities?.strategies ?? []) {
      tags.push(s)
    }
    return tags
  }

  // Marketplace id (the `server_id` part of `spec`) shown as a subtitle so the
  // installed gear mirrors the market card: title = display_name, subtitle = id.
  const gearSubtitle = (g: GearInfo): string | null => {
    if (g.spec && g.spec.includes(":")) return g.spec.slice(g.spec.indexOf(":") + 1)
    return null
  }

  const platform = usePlatform()

  const browseGearDir = async () => {
    try {
      const picked = await platform.openDirectoryPickerDialog?.({ title: language.t("settings.gear.browse") })
      const p = Array.isArray(picked) ? picked[0] : picked
      if (typeof p === "string") setGearDataDir(p)
    } catch {
      /* ignore */
    }
  }

  const saveGearDir = async (reset: boolean) => {
    setPathSaved(false)
    setPathError("")
    try {
      await tauriInvoke("set_gear_data_dir", { dir: reset ? null : gearDataDir().trim() || null })
      setPathSaved(true)
      void loadGearDataDir()
    } catch (e: any) {
      setPathError(e?.message ?? String(e))
    }
  }

  const removeGear = async (name: string) => {
    try {
      await gearRequest("DELETE", `/gears/${encodeURIComponent(name)}`)
      showToast({ variant: "success", title: language.t("settings.gear.deleted") })
      await loadGears()
    } catch (e: any) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: e?.message,
      })
    }
  }

  const setGearEnabled = async (name: string, enabled: boolean) => {
    // Optimistic update so the toggle feels instant.
    setGears((prev) => prev.map((g) => (g.name === name ? { ...g, enabled } : g)))
    try {
      await gearRequest("POST", `/gears/${encodeURIComponent(name)}/${enabled ? "enable" : "disable"}`)
    } catch (e: any) {
      showToast({
        variant: "error",
        title: language.t("common.saveFailed"),
        description: e?.message,
      })
      void loadGears()
    }
  }

  const setGearActivation = async (name: string, activation: "progressive" | "command") => {
    // Optimistic update so the toggle feels instant.
    setGears((prev) => prev.map((g) => (g.name === name ? { ...g, activation } : g)))
    try {
      await gearRequest("POST", `/gears/${encodeURIComponent(name)}/activation`, { activation })
    } catch (e: any) {
      showToast({
        variant: "error",
        title: language.t("common.saveFailed"),
        description: e?.message,
      })
      void loadGears()
    }
  }

  const submitMcp = async () => {
    if (mcpSubmitting()) return
    setMcpSubmitting(true)
    try {
      await gearRequest("POST", "/gears/mcp", {
        name: mcpName(),
        kind: "sse",
        url: mcpUrl(),
        description: mcpDesc(),
      })
      showToast({ variant: "success", title: language.t("settings.gear.mcpAdded") })
      dialog.back()
      await loadGears()
    } catch (e: any) {
      showToast({
        variant: "error",
        title: language.t("common.saveFailed"),
        description: e?.message,
      })
    } finally {
      setMcpSubmitting(false)
    }
  }

  const openMarket = () => {
    void import("@/components/dialog-market").then((m) => {
      // Return to Settings when the market is closed (don't tear down the
      // whole stack — Settings stays in the history).
      dialog.show(() => <m.DialogMarket />, undefined, "back")
    })
  }

  const InstallLocalGearDialog: Component = () => {
    const [path, setPath] = createSignal("")
    const [installing, setInstalling] = createSignal(false)

    const pick = async () => {
      let picked: string | string[] | null = null
      try {
        picked = await platform.openDirectoryPickerDialog?.({ title: language.t("settings.gear.pickFolder") }) ?? null
      } catch {
        picked = null
      }
      const p = Array.isArray(picked) ? picked[0] : picked
      if (typeof p === "string") setPath(p)
    }

    const submit = async () => {
      const p = path()
      if (!p) {
        showToast({ variant: "error", title: language.t("settings.gear.noPath") })
        return
      }
      setInstalling(true)
      try {
        await gearRequest("POST", "/gears/install", { path: p })
        showToast({ variant: "success", title: language.t("dialog.gear.install.success") })
        dialog.back()
        await loadGears()
      } catch (e: any) {
        showToast({ variant: "error", title: language.t("common.saveFailed"), description: e?.message })
      } finally {
        setInstalling(false)
      }
    }

    return (
      <Dialog title={language.t("settings.gear.createTitle")} fit>
        <div class="flex flex-col gap-5 px-[var(--dialog-gutter)] pb-5 pt-4 overflow-y-auto">
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-text-weak">{language.t("settings.gear.source")}</div>
            <div class="flex gap-2">
              <Button
                size="small"
                variant="primary"
                onClick={() => pick()}
              >
                {language.t("settings.gear.pickFolder")}
              </Button>
            </div>
            <Show when={path()}>
              <div class="text-12-regular text-text-weaker break-all">
                {language.t("settings.gear.selectedPath")}: {path()}
              </div>
            </Show>
          </div>
          <div class="flex justify-end gap-2">
            <Button size="small" variant="secondary" onClick={() => dialog.back()}>
              {language.t("settings.gear.cancel")}
            </Button>
            <Button size="small" variant="primary" disabled={!path() || installing()} onClick={submit}>
              {installing() ? language.t("common.loading.ellipsis") : language.t("settings.gear.install")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const AddMcpDialog: Component = () => (
    <Dialog title={language.t("settings.gear.addMcpTitle")} fit>
      <div class="flex flex-col gap-5 px-[var(--dialog-gutter)] pb-5 pt-4 overflow-y-auto">
        <TextField
          autofocus
          label={language.t("settings.gear.name")}
          description={language.t("settings.gear.remoteGearNameDesc")}
          placeholder={language.t("settings.gear.gearNamePlaceholder")}
          value={mcpName()}
          onChange={setMcpName}
        />
        <TextField
          label={language.t("settings.gear.mcpUrl")}
          description={language.t("settings.gear.mcpUrlDesc")}
          placeholder={language.t("settings.gear.mcpUrlPlaceholder")}
          value={mcpUrl()}
          onChange={setMcpUrl}
        />
        <TextField
          label={language.t("settings.gear.gearDescription")}
          placeholder={language.t("settings.gear.gearDescriptionPlaceholder")}
          value={mcpDesc()}
          onChange={setMcpDesc}
        />
        <div class="flex justify-end gap-2">
          <Button size="small" variant="secondary" onClick={() => dialog.back()}>
            {language.t("settings.gear.cancel")}
          </Button>
          <Button size="small" variant="primary" onClick={submitMcp} disabled={mcpSubmitting()}>
            {language.t("settings.gear.install")}
          </Button>
        </div>
      </div>
    </Dialog>
  )

  return (
    <SettingsPage
      title={language.t("settings.gear.title")}
      description={language.t("settings.gear.description")}
    >

      <div class="flex flex-wrap gap-2">
        <Button
          size="small"
          variant="secondary"
          onClick={() => dialog.show(() => <InstallLocalGearDialog />, undefined, "back")}
        >
          {language.t("settings.gear.create")}
        </Button>
        <Button
          size="small"
          variant="secondary"
          onClick={() => dialog.show(() => <AddMcpDialog />, undefined, "back")}
        >
          {language.t("settings.gear.addMcp")}
        </Button>
        <Button size="small" variant="secondary" onClick={openMarket}>
          {language.t("settings.gear.openMarket")}
        </Button>
      </div>

      {/* Data dir configuration is Tauri-only; on the web the invoke would be a
          silent no-op reported as success, so the whole block is desktop-only. */}
      <div class="flex flex-col gap-2 rounded-lg border border-surface-raised-base p-4">
        <div class="text-13-medium text-text-strong">{language.t("settings.gear.dataDir")}</div>
        <Show
          when={platform.platform !== "web"}
          fallback={
            <div class="text-12-regular text-text-weak">{language.t("settings.gear.dataDirOnlyDesktop")}</div>
          }
        >
          <div class="text-12-regular text-text-base">{language.t("settings.gear.dataDirDesc")}</div>
          <div class="flex items-center gap-2">
            <input
              class="flex-1 rounded border border-surface-raised-base bg-surface-base px-2 py-1 text-13-regular text-text-strong outline-none"
              type="text"
              placeholder={language.t("settings.gear.dataDirDesc")}
              value={gearDataDir()}
              onInput={(e) => setGearDataDir(e.currentTarget.value)}
            />
            <Button size="small" variant="secondary" onClick={browseGearDir}>
              {language.t("settings.gear.browse")}
            </Button>
          </div>
          <div class="flex items-center gap-2">
            <Button size="small" variant="primary" onClick={() => saveGearDir(false)}>
              {language.t("settings.gear.savePath")}
            </Button>
            <Button
              size="small"
              variant="secondary"
              onClick={() => {
                setGearDataDir("")
                void saveGearDir(true)
              }}
            >
              {language.t("settings.gear.resetPath")}
            </Button>
            <Show when={pathSaved()}>
              <span class="text-12-regular text-text-on-success-base">{language.t("settings.gear.pathSaved")}</span>
            </Show>
            <Show when={pathError()}>
              <span class="text-12-regular text-text-on-critical-base">{pathError()}</span>
            </Show>
          </div>
        </Show>
      </div>

      <SettingsList>
        <Show when={loading()}>
          <div class="py-3 text-12-regular text-text-weak">
            {language.t("common.loading.ellipsis")}
          </div>
        </Show>
        <Show when={!loading() && gears().length === 0}>
          <div class="py-3 text-12-regular text-text-weak">{language.t("settings.gear.empty")}</div>
        </Show>
        <For each={gears()}>
          {(g) => (
            <div class="flex items-start justify-between gap-3 py-3 border-b border-surface-raised-base last:border-0">
              <div class="flex flex-col gap-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-13-medium text-text-strong truncate">{g.displayName || g.display_name || g.name}</span>
                  <Show when={g.version}>
                    <span class="text-11-regular text-text-weaker">v{g.version}</span>
                  </Show>
                </div>
                <Show when={gearSubtitle(g)}>
                  <span class="text-11-regular text-text-weaker font-mono truncate">{gearSubtitle(g)}</span>
                </Show>
                <Show when={g.description}>
                  <div class="text-12-regular text-text-base truncate">{g.description}</div>
                </Show>
                <div class="flex flex-wrap gap-1">
                  <For each={capabilityTags(g)}>
                    {(c) => (
                      <span class="text-11-regular text-text-weaker bg-surface-raised-base rounded px-1.5 py-0.5">
                        {c}
                      </span>
                    )}
                  </For>
                </div>
              </div>
              <div class="flex flex-col items-end gap-2 shrink-0">
                <Show when={g.kind === "skill"}>
                  <label
                    class="flex items-center gap-2 text-11-regular text-text-weak cursor-pointer select-none"
                    title={language.t("settings.gear.autoCallHint")}
                  >
                    <span>{language.t("settings.gear.autoCall")}</span>
                    <Switch
                      checked={g.activation !== "command"}
                      onChange={(v: boolean) => void setGearActivation(g.name, v ? "progressive" : "command")}
                    />
                  </label>
                </Show>
                <label class="flex items-center gap-2 text-11-regular text-text-weak cursor-pointer select-none">
                  <span>{language.t("settings.gear.enabledLabel")}</span>
                  <Switch
                    checked={g.enabled}
                    onChange={(v: boolean) => void setGearEnabled(g.name, v)}
                  />
                </label>
                <Button size="small" variant="secondary" onClick={() => dialog.show(() => <ConfirmDeleteGear name={g.name} onConfirm={() => removeGear(g.name)} />, undefined, "back")}>
                  {language.t("settings.gear.delete")}
                </Button>
              </div>
            </div>
          )}
        </For>
      </SettingsList>
    </SettingsPage>
  )
}

const ConfirmDeleteGear: Component<{ name: string; onConfirm: () => void }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <DialogConfirm
      title={language.t("settings.gear.delete")}
      danger
      confirmLabel={language.t("common.delete")}
      message={language.t("settings.gear.confirmDelete", { name: props.name })}
      onConfirm={() => {
        props.onConfirm()
        dialog.back()
      }}
      onCancel={() => dialog.back()}
    />
  )
}
