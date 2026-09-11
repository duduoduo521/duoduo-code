import { Component, Show, createMemo, createSignal, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@duoduo-ai/ui/button"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Icon } from "@duoduo-ai/ui/icon"
import { Select } from "@duoduo-ai/ui/select"
import { Switch } from "@duoduo-ai/ui/switch"
import { TextField } from "@duoduo-ai/ui/text-field"
import { Tooltip } from "@duoduo-ai/ui/tooltip"
import { useTheme, type ColorScheme } from "@duoduo-ai/ui/theme/context"
import { showToast } from "@duoduo-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { themeName } from "@/utils/theme-name"
import { usePermission } from "@/context/permission"
import { DialogAutoAcceptRisk } from "./dialog-auto-accept-risk"
import { usePlatform, type DisplayBackend } from "@/context/platform"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/context/settings"
import { decode64 } from "@/utils/base64"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSmartLayer } from "@/addons/smart-layer/context"
import { SettingsList } from "./settings-list"
import { SettingsPage } from "./settings-page"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
  run: 0,
}

type ThemeOption = {
  id: string
  name: string
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const stopDemoSound = () => {
  demoSoundState.run += 1
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }
  clearTimeout(demoSoundState.timeout)
  demoSoundState.cleanup = undefined
}

const playDemoSound = (id: string | undefined) => {
  stopDemoSound()
  if (!id) return

  const run = ++demoSoundState.run
  demoSoundState.timeout = setTimeout(() => {
    void playSoundById(id).then((cleanup) => {
      if (demoSoundState.run !== run) {
        cleanup?.()
        return
      }
      demoSoundState.cleanup = cleanup
    })
  }, 100)
}

export const SettingsGeneral: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const permission = usePermission()
  const dialog = useDialog()
  const platform = usePlatform()
  const params = useParams()
  const settings = useSettings()
  const globalSDK = useGlobalSDK()
  const smartLayer = useSmartLayer()

  onMount(() => {
    void theme.loadThemes().catch(() => {})
    // System fonts are fetched after mount and never block/suspend rendering —
    // the dropdown starts with the built-in presets and fills in once the
    // (backend/Tauri) enumeration returns. Failures just keep the presets.
    if (platform.listSystemFonts) {
      void platform
        .listSystemFonts()
        .then((fonts) => setSystemFonts(fonts ?? []))
        .catch(() => {})
    }
    void refreshDisplayBackend()
    // Load the global thinking setting from the backend so the control reflects
    // the persisted LlmConfig (these live in /agent/config, not in the local
    // per-session UI settings store). Temperature is now configured per-model
    // in the add-model dialog.
    const api = smartLayer?.api
    if (api) {
      void api.getLlmConfig().then((cfg) => {
        setStore({
          enableThinking: typeof cfg.enableThinking === "boolean" ? cfg.enableThinking : true,
        })
      }).catch(() => {})
    }
  })

  const [store, setStore] = createStore({
    checking: false,
    enableThinking: true as boolean,
  })

  const flushLlmConfig = (patch: { enableThinking?: boolean }) => {
    const api = smartLayer?.api
    if (!api) return
    void api.getLlmConfig().then((cfg) => {
      void api.configureLlm({
        provider: cfg.provider,
        defaultModelId: cfg.defaultModelId,
        ...(typeof cfg.contextWindow === "number" ? { contextWindow: cfg.contextWindow } : {}),
        ...(typeof cfg.maxOutputTokens === "number" ? { maxOutputTokens: cfg.maxOutputTokens } : {}),
        ...(cfg.fallbackModels ? { fallbackModels: cfg.fallbackModels } : {}),
        ...(typeof cfg.enableThinking === "boolean" ? { enableThinking: cfg.enableThinking } : {}),
        ...patch,
      })
    }).catch(() => {})
  }

  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  // Display backend is fetched after mount and never suspends rendering — see
  // the `systemFonts` note below: a pending resource here would blank the whole
  // routed UI while it settles.
  const [displayBackend, setDisplayBackend] = createSignal<DisplayBackend | null>(null)
  const refreshDisplayBackend = async () => {
    if (!linux() || !platform.getDisplayBackend) return
    try {
      setDisplayBackend((await platform.getDisplayBackend()) ?? null)
    } catch {
      setDisplayBackend(null)
    }
  }
  const dir = createMemo(() => decode64(params.dir))
  const accepting = createMemo(() => {
    const value = dir()
    if (!value) return false
    if (!params.id) return permission.isAutoAcceptingDirectory(value)
    return permission.isAutoAccepting(params.id, value)
  })

  const toggleAccept = (checked: boolean) => {
    const value = dir()
    if (!value) return

    // Turning OFF requires no extra confirmation.
    if (!checked) {
      if (!params.id) {
        if (permission.isAutoAcceptingDirectory(value) === checked) return
        permission.toggleAutoAcceptDirectory(value)
        return
      }
      permission.disableAutoAccept(params.id, value)
      return
    }

    // Turning ON: require explicit risk acknowledgment before enabling.
    dialog.show(() => (
      <DialogAutoAcceptRisk
        onConfirm={() => {
          if (!params.id) permission.toggleAutoAcceptDirectory(value)
          else permission.enableAutoAccept(params.id, value)
        }}
      />
    ))
  }
  const desktop = createMemo(() => platform.platform === "desktop")

  const check = () => {
    if (!platform.checkUpdate) return
    setStore("checking", true)

    void platform
      .checkUpdate()
      .then((result) => {
        if (!result.updateAvailable) {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", {
              version: platform.version?.() ?? "",
            }),
          })
          return
        }

        // checkUpdate starts a background download; show toast after a short delay
        // so the download has time to complete.
        setTimeout(() => {
          showToast({
            persistent: true,
            icon: "download",
            title: language.t("toast.update.title"),
            description: language.t("toast.update.downloaded.description", { version: result.version ?? "" }),
            actions: [
              {
                label: language.t("toast.update.action.restart"),
                onClick: async () => {
                  if (platform.updateAndRestart) {
                    await platform.updateAndRestart()
                  } else {
                    await platform.update!()
                    await platform.restart()
                  }
                },
              },
              {
                label: language.t("toast.update.action.dismiss"),
                onClick: "dismiss" as const,
              },
            ],
          })
        }, 3000)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setStore("checking", false))
  }

  const themeOptions = createMemo<ThemeOption[]>(() =>
    theme.ids().map((id) => ({ id, name: themeName(id, language.t, theme.name(id)) })),
  )

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  const noneSound = { id: "none", label: "sound.option.none" } as const
  const soundOptions = [noneSound, ...SOUND_OPTIONS]
  const mono = () => monoInput(settings.appearance.font())
  const sans = () => sansInput(settings.appearance.uiFont())
  const terminal = () => terminalInput(settings.appearance.terminalFont())

  // ── System font list for Select dropdowns ──
  // NOTE: deliberately a plain signal, NOT createResource. This component is
  // rendered inside the Settings dialog, whose reactive owner (see
  // context/dialog.tsx -> runWithOwner(caller)) still lives under the route-level
  // <Suspense fallback={<Loading/>}> in app.tsx. A pending resource there bumps
  // the Suspense counter, which swaps the ENTIRE routed UI for a full-screen
  // `bg-background-base` Loading layer until the fetch settles — i.e. clicking
  // the "通用" tab blanks the app for as long as the font enumeration takes
  // (Windows spawns powershell; ~0.5s warm, seconds on a cold install).
  // Fonts are only a supplement to the dropdown, so they must never suspend.
  const [systemFonts, setSystemFonts] = createSignal<string[]>([])

  const fontOptions = createMemo(() => {
    const system = systemFonts()
    // Built-in font presets always shown first (deduped: terminalDefault is the
    // same string as the hard-coded entry below).
    const builtin = [...new Set([sansDefault, monoDefault, terminalDefault, "JetBrainsMono Nerd Font Mono"])]
    const seen = new Set(builtin)
    const all = builtin.filter(Boolean).map((f) => ({ value: f, label: f }))
    for (const f of system) {
      if (!seen.has(f)) {
        seen.add(f)
        all.push({ value: f, label: f })
      }
    }
    return all
  })

  const currentFontOption = (current: string | undefined, fallback: string) => {
    const value = current?.trim() || fallback
    return fontOptions().find((o) => o.value === value) ?? { value, label: value }
  }

  const soundSelectProps = (
    enabled: () => boolean,
    current: () => string,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    options: soundOptions,
    current: enabled() ? (soundOptions.find((o) => o.id === current()) ?? noneSound) : noneSound,
    value: (o: (typeof soundOptions)[number]) => o.id,
    label: (o: (typeof soundOptions)[number]) => language.t(o.label),
    onHighlight: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      playDemoSound(option.id === "none" ? undefined : option.id)
    },
    onSelect: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        stopDemoSound()
        return
      }
      setEnabled(true)
      set(option.id)
      playDemoSound(option.id)
    },
    variant: "secondary" as const,
    size: "small" as const,
    triggerVariant: "settings" as const,
  })

  const GeneralSection = () => (
    <div class="flex flex-col gap-1">
      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.language.title")}
          description={language.t("settings.general.row.language.description")}
        >
          <Select
            data-action="settings-language"
            options={languageOptions()}
            current={languageOptions().find((o) => o.value === language.locale())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && language.setLocale(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("command.permissions.autoaccept.enable")}
          description={language.t("toast.permissions.autoaccept.on.description")}
        >
          <div data-action="settings-auto-accept-permissions">
            <Switch checked={accepting()} disabled={!dir()} onChange={toggleAccept} />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showThinking.title")}
          description={language.t("settings.general.row.showThinking.description")}
        >
          <div data-action="settings-show-thinking">
            <Switch
              checked={settings.general.showThinking()}
              onChange={(checked) => settings.general.setShowThinking(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.shellToolPartsExpanded.title")}
          description={language.t("settings.general.row.shellToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-shell-tool-parts-expanded">
            <Switch
              checked={settings.general.shellToolPartsExpanded()}
              onChange={(checked) => settings.general.setShellToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.editToolPartsExpanded.title")}
          description={language.t("settings.general.row.editToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-edit-tool-parts-expanded">
            <Switch
              checked={settings.general.editToolPartsExpanded()}
              onChange={(checked) => settings.general.setEditToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.lineWrapping.title")}
          description={language.t("settings.general.row.lineWrapping.description")}
        >
          <div data-action="settings-line-wrapping">
            <Switch
              checked={settings.general.lineWrapping()}
              onChange={(checked) => settings.general.setLineWrapping(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.tabWrapping.title")}
          description={language.t("settings.general.row.tabWrapping.description")}
        >
          <div data-action="settings-tab-wrapping">
            <Switch
              checked={settings.general.tabWrapping()}
              onChange={(checked) => settings.general.setTabWrapping(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={
            <div class="flex items-center gap-2">
              <span>{language.t("settings.general.row.syntaxCheck.title")}</span>
              <Tooltip value={language.t("settings.general.row.syntaxCheck.description")} placement="top">
                <span class="text-text-weak">
                  <Icon name="help" size="small" />
                </span>
              </Tooltip>
            </div>
          }
          description={language.t("settings.general.row.syntaxCheck.description")}
        >
          <div data-action="settings-syntax-check">
            <Switch
              checked={settings.general.syntaxCheck()}
              onChange={(checked) => {
                settings.general.setSyntaxCheck(checked)
                smartLayer.api
                  ?.post("/agent/loop_config", {
                    syntaxCheck: checked,
                    reflect: settings.general.reflect(),
                  })
                  .catch(() =>
                    showToast({
                      title: language.t("toast.loopConfig.failed.title"),
                      description: language.t("toast.loopConfig.failed.description"),
                      variant: "error",
                    }),
                  )
              }}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={
            <div class="flex items-center gap-2">
              <span>{language.t("settings.general.row.reflect.title")}</span>
              <Tooltip value={language.t("settings.general.row.reflect.description")} placement="top">
                <span class="text-text-weak">
                  <Icon name="help" size="small" />
                </span>
              </Tooltip>
            </div>
          }
          description={language.t("settings.general.row.reflect.description")}
        >
          <div data-action="settings-reflect">
            <Switch
              checked={settings.general.reflect()}
              onChange={(checked) => {
                settings.general.setReflect(checked)
                // Drive Rust reflect (L3 self-correction) via LoopConfig.
                smartLayer.api
                  ?.post("/agent/loop_config", {
                    syntaxCheck: settings.general.syntaxCheck(),
                    reflect: checked,
                  })
                  .catch(() =>
                    showToast({
                      title: language.t("toast.loopConfig.failed.title"),
                      description: language.t("toast.loopConfig.failed.description"),
                      variant: "error",
                    }),
                  )
                // Keep the TS-side cascade (LSP verification) aligned with the
                // same "审校" intent. cascadeQA is retained only as the TS
                // transport; it is no longer a standalone UI switch.
                fetch(`${globalSDK.url}/session/cascade-qa`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ cascadeQA: checked }),
                }).catch(() =>
                  showToast({
                    title: language.t("toast.loopConfig.failed.title"),
                    description: language.t("toast.loopConfig.failed.description"),
                    variant: "error",
                  }),
                )
              }}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={
            <div class="flex items-center gap-2">
              <span>{language.t("settings.general.row.parallelDispatch.title")}</span>
              <Tooltip value={language.t("settings.general.row.parallelDispatch.description")} placement="top">
                <span class="text-text-weak">
                  <Icon name="help" size="small" />
                </span>
              </Tooltip>
            </div>
          }
          description={language.t("settings.general.row.parallelDispatch.description")}
        >
          <div data-action="settings-parallel-dispatch">
            <Switch
              checked={settings.general.parallelDispatch()}
              onChange={(checked) => {
                settings.general.setParallelDispatch(checked)
                // Drive Rust G7 parallel multi-agent dispatch via LoopConfig.
                // Send all three flags so the Rust side stays consistent.
                smartLayer.api
                  ?.post("/agent/loop_config", {
                    syntaxCheck: settings.general.syntaxCheck(),
                    reflect: settings.general.reflect(),
                    parallelDispatch: checked,
                  })
                  .catch(() =>
                    showToast({
                      title: language.t("toast.loopConfig.failed.title"),
                      description: language.t("toast.loopConfig.failed.description"),
                      variant: "error",
                    }),
                  )
              }}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={
            <div class="flex items-center gap-2">
              <span>{language.t("settings.general.row.agentMaxSteps.title")}</span>
              <Tooltip value={language.t("settings.general.row.agentMaxSteps.description")} placement="top">
                <span class="text-text-weak">
                  <Icon name="help" size="small" />
                </span>
              </Tooltip>
            </div>
          }
          description={language.t("settings.general.row.agentMaxSteps.description")}
        >
          <div data-action="settings-agent-max-steps" class="w-28">
            <TextField
              type="number"
              min={-1}
              value={String(settings.general.agentMaxSteps())}
              onChange={(raw: string) => {
                // -1 = unlimited (no step cap). 0 is preserved as "no tools at
                // all" (immediate stop) for backward compatibility. NaN/invalid
                // input falls back to -1 to match the backend default.
                const rawN = Math.trunc(Number(raw))
                const next = Number.isFinite(rawN) ? Math.max(-1, rawN) : -1
                settings.general.setAgentMaxSteps(next)
                // Drive Rust loop max_steps via LoopConfig (kept consistent with
                // the other loop flags). Takes effect on the next run_loop.
                smartLayer.api
                  ?.post("/agent/loop_config", {
                    syntaxCheck: settings.general.syntaxCheck(),
                    reflect: settings.general.reflect(),
                    parallelDispatch: settings.general.parallelDispatch(),
                    maxSteps: next,
                  })
                  .catch(() =>
                    showToast({
                      title: language.t("toast.loopConfig.failed.title"),
                      description: language.t("toast.loopConfig.failed.description"),
                      variant: "error",
                    }),
                  )
              }}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.thinking.title")}
          description={language.t("settings.general.row.thinking.description")}
        >
          <Switch
            checked={store.enableThinking}
            onChange={(checked) => {
              setStore("enableThinking", checked)
              flushLlmConfig({ enableThinking: checked })
            }}
          />
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const AdvancedSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.advanced")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.showFileTree.title")}
          description={language.t("settings.general.row.showFileTree.description")}
        >
          <div data-action="settings-show-file-tree">
            <Switch
              checked={settings.general.showFileTree()}
              onChange={(checked) => settings.general.setShowFileTree(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showNavigation.title")}
          description={language.t("settings.general.row.showNavigation.description")}
        >
          <div data-action="settings-show-navigation">
            <Switch
              checked={settings.general.showNavigation()}
              onChange={(checked) => settings.general.setShowNavigation(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showSearch.title")}
          description={language.t("settings.general.row.showSearch.description")}
        >
          <div data-action="settings-show-search">
            <Switch
              checked={settings.general.showSearch()}
              onChange={(checked) => settings.general.setShowSearch(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showTerminal.title")}
          description={language.t("settings.general.row.showTerminal.description")}
        >
          <div data-action="settings-show-terminal">
            <Switch
              checked={settings.general.showTerminal()}
              onChange={(checked) => settings.general.setShowTerminal(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showStatus.title")}
          description={language.t("settings.general.row.showStatus.description")}
        >
          <div data-action="settings-show-status">
            <Switch
              checked={settings.general.showStatus()}
              onChange={(checked) => settings.general.setShowStatus(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const AppearanceSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.appearance")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <Select
            data-action="settings-color-scheme"
            options={colorSchemeOptions()}
            current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && theme.setColorScheme(option.value)}
            onHighlight={(option) => {
              if (!option) return
              theme.previewColorScheme(option.value)
              return () => theme.cancelPreview()
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "220px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.theme.title")}
          description={language.t("settings.general.row.theme.description")}
        >
          <Select
            data-action="settings-theme"
            options={themeOptions()}
            current={themeOptions().find((o) => o.id === theme.themeId())}
            value={(o) => o.id}
            label={(o) => o.name}
            onSelect={(option) => {
              if (!option) return
              theme.setTheme(option.id)
            }}
            onHighlight={(option) => {
              if (!option) return
              theme.previewTheme(option.id)
              return () => theme.cancelPreview()
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.fontSize.title")}
          description={language.t("settings.general.row.fontSize.description")}
        >
          <div class="flex items-center gap-2">
            <button
              data-action="settings-font-size-decrease"
              class="flex items-center justify-center w-7 h-7 rounded border border-border-weak-base bg-surface-raised-base text-text-strong hover:bg-surface-interactive-base hover:text-text-on-interactive transition-colors"
              onClick={() => settings.appearance.setFontSize(Math.max(8, settings.appearance.fontSize() - 1))}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 7H11" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
            <span class="text-12-regular text-text-strong min-w-[3ch] text-center tabular-nums">
              {settings.appearance.fontSize()}
            </span>
            <button
              data-action="settings-font-size-increase"
              class="flex items-center justify-center w-7 h-7 rounded border border-border-weak-base bg-surface-raised-base text-text-strong hover:bg-surface-interactive-base hover:text-text-on-interactive transition-colors"
              onClick={() => settings.appearance.setFontSize(Math.min(32, settings.appearance.fontSize() + 1))}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 7H11M7 3V11" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.uiFont.title")}
          description={language.t("settings.general.row.uiFont.description")}
        >
          <Select
            data-action="settings-ui-font"
            options={fontOptions()}
            current={currentFontOption(settings.appearance.uiFont(), sansDefault)}
            value={(o: { value: string; label: string }) => o.value}
            label={(o: { value: string; label: string }) => o.label}
            onSelect={(option) => option && settings.appearance.setUIFont(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.font.title")}
          description={language.t("settings.general.row.font.description")}
        >
          <Select
            data-action="settings-code-font"
            options={fontOptions()}
            current={currentFontOption(settings.appearance.font(), monoDefault)}
            value={(o: { value: string; label: string }) => o.value}
            label={(o: { value: string; label: string }) => o.label}
            onSelect={(option) => option && settings.appearance.setFont(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.terminalFont.title")}
          description={language.t("settings.general.row.terminalFont.description")}
        >
          <Select
            data-action="settings-terminal-font"
            options={fontOptions()}
            current={currentFontOption(settings.appearance.terminalFont(), terminalDefault)}
            value={(o: { value: string; label: string }) => o.value}
            label={(o: { value: string; label: string }) => o.label}
            onSelect={(option) => option && settings.appearance.setTerminalFont(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const NotificationsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.notifications")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const SoundsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.sounds")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.sounds.agent.title")}
          description={language.t("settings.general.sounds.agent.description")}
        >
          <Select
            data-action="settings-sounds-agent"
            {...soundSelectProps(
              () => settings.sounds.agentEnabled(),
              () => settings.sounds.agent(),
              (value) => settings.sounds.setAgentEnabled(value),
              (id) => settings.sounds.setAgent(id),
            )}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.sounds.permissions.title")}
          description={language.t("settings.general.sounds.permissions.description")}
        >
          <Select
            data-action="settings-sounds-permissions"
            {...soundSelectProps(
              () => settings.sounds.permissionsEnabled(),
              () => settings.sounds.permissions(),
              (value) => settings.sounds.setPermissionsEnabled(value),
              (id) => settings.sounds.setPermissions(id),
            )}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.sounds.errors.title")}
          description={language.t("settings.general.sounds.errors.description")}
        >
          <Select
            data-action="settings-sounds-errors"
            {...soundSelectProps(
              () => settings.sounds.errorsEnabled(),
              () => settings.sounds.errors(),
              (value) => settings.sounds.setErrorsEnabled(value),
              (id) => settings.sounds.setErrors(id),
            )}
          />
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const UpdatesSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.updates")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.updates.row.startup.title")}
          description={language.t("settings.updates.row.startup.description")}
        >
          <div data-action="settings-updates-startup">
            <Switch
              checked={settings.updates.startup()}
              disabled={!platform.checkUpdate}
              onChange={(checked) => settings.updates.setStartup(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.updates.row.check.title")}
          description={language.t("settings.updates.row.check.description")}
        >
          <Button size="small" variant="secondary" disabled={store.checking || !platform.checkUpdate} onClick={check}>
            {store.checking
              ? language.t("settings.updates.action.checking")
              : language.t("settings.updates.action.checkNow")}
          </Button>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  return (
    <SettingsPage title={language.t("settings.tab.general")}>
      <div class="flex flex-col gap-8 w-full">
        <GeneralSection />

        <AppearanceSection />

        <NotificationsSection />

        <SoundsSection />

        {/*<Show when={platform.platform === "desktop" && platform.os === "windows" && platform.getWslEnabled}>
          {(_) => {
            const [enabledResource, actions] = createResource(() => platform.getWslEnabled?.())
            const enabled = () => (enabledResource.state === "pending" ? undefined : enabledResource.latest)

            return (
              <div class="flex flex-col gap-1">
                <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.desktop.section.wsl")}</h3>

                <SettingsList>
                  <SettingsRow
                    title={language.t("settings.desktop.wsl.title")}
                    description={language.t("settings.desktop.wsl.description")}
                  >
                    <div data-action="settings-wsl">
                      <Switch
                        checked={enabled() ?? false}
                        disabled={enabledResource.state === "pending"}
                        onChange={(checked) => platform.setWslEnabled?.(checked)?.finally(() => actions.refetch())}
                      />
                    </div>
                  </SettingsRow>
                </SettingsList>
              </div>
            )
          }}
        </Show>*/}

        <UpdatesSection />

        <Show when={linux()}>
          <div class="flex flex-col gap-1">
            <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.display")}</h3>

            <SettingsList>
              <SettingsRow
                title={
                  <div class="flex items-center gap-2">
                    <span>{language.t("settings.general.row.wayland.title")}</span>
                    <Tooltip value={language.t("settings.general.row.wayland.tooltip")} placement="top">
                      <span class="text-text-weak">
                        <Icon name="help" size="small" />
                      </span>
                    </Tooltip>
                  </div>
                }
                description={language.t("settings.general.row.wayland.description")}
              >
                <div data-action="settings-wayland">
                  <Switch
                    checked={displayBackend() === "wayland"}
                    onChange={(checked) => {
                      void platform
                        .setDisplayBackend?.(checked ? "wayland" : "auto")
                        .finally(() => void refreshDisplayBackend())
                    }}
                  />
                </div>
              </SettingsRow>
            </SettingsList>
          </div>
        </Show>

        <Show when={desktop() && import.meta.env.VITE_DUODUO_CHANNEL === "beta"}>
          <AdvancedSection />
        </Show>
      </div>
    </SettingsPage>
  )
}

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}
