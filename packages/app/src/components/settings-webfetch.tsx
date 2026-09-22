import { Component, For, Show, createMemo, createSignal, onMount } from "solid-js"
import { useParams } from "@solidjs/router"
import { Button } from "@duoduo-ai/ui/button"
import { TextField } from "@duoduo-ai/ui/text-field"
import { showToast } from "@duoduo-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { decode64 } from "@/utils/base64"
import { SettingsList } from "./settings-list"
import { SettingsPage } from "./settings-page"

// H4: mirrors the DEFAULT_WEBFETCH_RULES shape in
// packages/duoduo/src/tool/webfetch.ts — the backend always enforces its own
// built-in reserved-range defaults on top of these user rules in blacklist
// mode, so this list is an editable starting point, not the enforcement
// source. Keep the two in sync when ranges change.
interface WebfetchRule {
  pattern: string
  action: "allow" | "block"
  enabled: boolean
}

const DEFAULT_RULES: WebfetchRule[] = [
  { pattern: "localhost", action: "block", enabled: true },
  { pattern: "*.localhost", action: "block", enabled: true },
  { pattern: "*.internal", action: "block", enabled: true },
  { pattern: "0.0.0.0/8", action: "block", enabled: true },
  { pattern: "10.0.0.0/8", action: "block", enabled: true },
  { pattern: "127.0.0.0/8", action: "block", enabled: true },
  { pattern: "169.254.0.0/16", action: "block", enabled: true },
  { pattern: "172.16.0.0/12", action: "block", enabled: true },
  { pattern: "192.168.0.0/16", action: "block", enabled: true },
  { pattern: "100.64.0.0/10", action: "block", enabled: true },
  { pattern: "::1/128", action: "block", enabled: true },
  { pattern: "fe80::/10", action: "block", enabled: true },
  { pattern: "fc00::/7", action: "block", enabled: true },
]

type AccessMode = "blacklist" | "whitelist"

export const SettingsWebfetch: Component = () => {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const params = useParams()

  // Config is global in meaning but edited through the instance-scoped
  // endpoint (same mechanism as the snapshot settings page).
  const directory = createMemo(() => decode64(params.dir))

  const [mode, setMode] = createSignal<AccessMode>("blacklist")
  const [rules, setRules] = createSignal<WebfetchRule[]>([])
  const [newPattern, setNewPattern] = createSignal("")
  const [newAction, setNewAction] = createSignal<"allow" | "block">("block")
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)

  const load = async () => {
    const dir = directory()
    if (!dir) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const { data } = await globalSDK.client.config.get({ directory: dir }, { throwOnError: true })
      if (data.webfetch_access_mode === "whitelist") setMode("whitelist")
      // No stored rules yet → show the default reserved-range set as an
      // editable starting point; saving persists exactly what is shown.
      const stored = Array.isArray(data.webfetch_rules) ? data.webfetch_rules : null
      setRules(
        stored ?? DEFAULT_RULES.map((r) => ({ ...r })),
      )
    } catch {
      showToast({ variant: "error", title: language.t("common.requestFailed") })
    } finally {
      setLoading(false)
    }
  }

  const save = async () => {
    const dir = directory()
    if (!dir) return
    setSaving(true)
    try {
      await globalSDK.client.config.update(
        {
          directory: dir,
          config: {
            webfetch_access_mode: mode(),
            webfetch_rules: rules(),
          },
        },
        { throwOnError: true },
      )
      showToast({ variant: "success", title: language.t("settings.webfetch.saved") })
    } catch (e: any) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: e?.message })
    } finally {
      setSaving(false)
    }
  }

  onMount(load)

  const addRule = () => {
    const pattern = newPattern().trim()
    if (!pattern) {
      showToast({ variant: "error", title: language.t("settings.webfetch.invalidPattern") })
      return
    }
    // Local sanity check mirroring the backend pattern forms (IP, CIDR,
    // domain, *.domain). The policy engine tolerates unknown patterns (they
    // simply never match), so this is guidance rather than enforcement.
    if (/\s/.test(pattern)) {
      showToast({ variant: "error", title: language.t("settings.webfetch.invalidPattern") })
      return
    }
    setRules([...rules(), { pattern, action: newAction(), enabled: true }])
    setNewPattern("")
  }

  return (
    <SettingsPage
      title={language.t("settings.webfetch.title")}
      description={language.t("settings.webfetch.description")}
    >
      <Show
        when={!loading() && !!directory()}
        fallback={
          <div class="text-13-regular text-text-weak">
            {directory() ? language.t("common.loading.ellipsis") : language.t("settings.snapshot.unavailable")}
          </div>
        }
      >
        <SettingsList>
          <div class="flex flex-col gap-3 py-3">
            <div class="text-13-medium text-text-strong">{language.t("settings.webfetch.mode")}</div>
            <div class="text-12-regular text-text-weak">{language.t("settings.webfetch.modeDesc")}</div>
            <div class="flex gap-2">
              <Button
                size="small"
                variant={mode() === "blacklist" ? "primary" : "secondary"}
                onClick={() => setMode("blacklist")}
              >
                {language.t("settings.webfetch.modeBlacklist")}
              </Button>
              <Button
                size="small"
                variant={mode() === "whitelist" ? "primary" : "secondary"}
                onClick={() => setMode("whitelist")}
              >
                {language.t("settings.webfetch.modeWhitelist")}
              </Button>
            </div>
            <div class="text-12-regular text-text-weak">
              {mode() === "blacklist"
                ? language.t("settings.webfetch.modeBlacklistDesc")
                : language.t("settings.webfetch.modeWhitelistDesc")}
            </div>
          </div>
        </SettingsList>

        <SettingsList>
          <div class="flex flex-col gap-3 py-3">
            <div class="text-13-medium text-text-strong">{language.t("settings.webfetch.rules")}</div>
            <div class="text-12-regular text-text-weak">{language.t("settings.webfetch.rulesDesc")}</div>

            <Show
              when={rules().length > 0}
              fallback={<div class="text-12-regular text-text-weak">{language.t("settings.webfetch.empty")}</div>}
            >
              <div class="flex flex-col gap-2">
                <For each={rules()}>
                  {(rule, index) => (
                    <div class="flex items-center gap-2 text-13-regular">
                      <span class="flex-1 break-all text-text-strong font-mono">{rule.pattern}</span>
                      <button
                        type="button"
                        class={`rounded px-2 py-0.5 text-11-medium ${rule.action === "allow" ? "bg-text-success/15 text-text-success" : "bg-text-danger/15 text-text-danger"}`}
                        onClick={() => {
                          const next = [...rules()]
                          next[index()] = { ...rule, action: rule.action === "allow" ? "block" : "allow" }
                          setRules(next)
                        }}
                      >
                        {rule.action === "allow"
                          ? language.t("settings.webfetch.allow")
                          : language.t("settings.webfetch.block")}
                      </button>
                      <button
                        type="button"
                        class={`rounded px-2 py-0.5 text-11-medium ${rule.enabled ? "text-text-strong" : "text-text-weak"}`}
                        onClick={() => {
                          const next = [...rules()]
                          next[index()] = { ...rule, enabled: !rule.enabled }
                          setRules(next)
                        }}
                      >
                        {rule.enabled
                          ? language.t("settings.webfetch.enabled")
                          : language.t("settings.webfetch.disabled")}
                      </button>
                      <button
                        type="button"
                        class="text-11-medium text-text-danger"
                        onClick={() => setRules(rules().filter((_, i) => i !== index()))}
                      >
                        {language.t("settings.webfetch.delete")}
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <div class="flex items-end gap-2 pt-1">
              <div class="flex flex-col gap-2 flex-1">
                <TextField
                  value={newPattern()}
                  onChange={setNewPattern}
                  placeholder={language.t("settings.webfetch.patternPlaceholder")}
                />
              </div>
              <Button
                size="small"
                variant={newAction() === "allow" ? "secondary" : "secondary"}
                onClick={() => setNewAction(newAction() === "allow" ? "block" : "allow")}
              >
                {newAction() === "allow"
                  ? language.t("settings.webfetch.allow")
                  : language.t("settings.webfetch.block")}
              </Button>
              <Button size="small" variant="primary" onClick={addRule}>
                {language.t("settings.webfetch.addRule")}
              </Button>
            </div>
          </div>
        </SettingsList>

        <SettingsList>
          <div class="flex justify-end py-3">
            <Button variant="primary" onClick={save} disabled={saving()}>
              {saving() ? language.t("common.loading.ellipsis") : language.t("settings.webfetch.save")}
            </Button>
          </div>
        </SettingsList>
      </Show>
    </SettingsPage>
  )
}
