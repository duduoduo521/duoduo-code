import { createStore, reconcile } from "solid-js/store"
import { createEffect, createMemo } from "solid-js"
import { createSimpleContext } from "@duoduo-ai/ui/context"
import { persisted } from "@/utils/persist"

export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  agentEnabled: boolean
  agent: string
  permissionsEnabled: boolean
  permissions: string
  errorsEnabled: boolean
  errors: string
}

export interface Settings {
  general: {
    autoSave: boolean
    showFileTree: boolean
    showNavigation: boolean
    showSearch: boolean
    showStatus: boolean
    showTerminal: boolean
    showThinking: boolean
    shellToolPartsExpanded: boolean
    editToolPartsExpanded: boolean
    lineWrapping: boolean
    tabWrapping: boolean
    syntaxCheck: boolean
    reflect: boolean
    parallelDispatch: boolean
    agentMaxSteps: number
  }
  loop: {
    subAgentMaxRounds: number
    subAgentTimeoutSecs: number
    subAgentMaxTotalTokens: number
    subAgentMaxFileReads: number
  }
  updates: {
    startup: boolean
  }
  appearance: {
    fontSize: number
    mono: string
    sans: string
    terminal: string
  }
  keybinds: Record<string, string>
  permissions: {
    autoApprove: boolean
  }
  notifications: NotificationSettings
  sounds: SoundSettings
  logs: {
    retentionDays: number
  }
  market: {
    source: string
  }
}

export const monoDefault = "System Mono"
export const sansDefault = "System Sans"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"

// "DuoDuo Mono CJK" is a size-adjusted alias over the bundled Noto Sans SC
// slices (see scripts/gen-mono-cjk.ts). JetBrains Mono carries no CJK glyphs,
// so every Chinese run falls through to it and lands on the monospace grid.
const monoFallback =
  '"JetBrainsMono Nerd Font Mono", "DuoDuo Mono CJK", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
// NOTE: this wins over the `--font-family-sans` declared in
// packages/ui/src/styles/theme.css — it is applied as an inline style on
// <html>. Keep the two in sync.
// "Noto Sans SC" is the bundled OFL-licensed face; the rest are system
// fallbacks for the window before it finishes loading.
const sansFallback =
  '"Noto Sans SC", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
const terminalFallback =
  '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const monoBase = monoFallback
const sansBase = sansFallback
const terminalBase = terminalFallback

function input(font: string | undefined) {
  return font ?? ""
}

function family(font: string) {
  if (/^[\w-]+$/.test(font)) return font
  return `"${font.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function stack(font: string | undefined, base: string) {
  const value = font?.trim() ?? ""
  if (!value) return base
  return `${family(value)}, ${base}`
}

export function monoInput(font: string | undefined) {
  return input(font)
}

export function sansInput(font: string | undefined) {
  return input(font)
}

export function monoFontFamily(font: string | undefined) {
  return stack(font, monoBase)
}

export function sansFontFamily(font: string | undefined) {
  return stack(font, sansBase)
}

export function terminalInput(font: string | undefined) {
  return input(font)
}

export function terminalFontFamily(font: string | undefined) {
  return stack(font, terminalBase)
}

const defaultSettings: Settings = {
  general: {
    autoSave: true,
    showFileTree: false,
    showNavigation: false,
    showSearch: false,
    showStatus: false,
    showTerminal: false,
    showThinking: true,
    shellToolPartsExpanded: false,
    editToolPartsExpanded: false,
    lineWrapping: false,
    tabWrapping: false,
    syntaxCheck: true,
    reflect: true,
    parallelDispatch: false,
    agentMaxSteps: -1,
  },
  loop: {
    subAgentMaxRounds: 100,
    subAgentTimeoutSecs: 1800,
    subAgentMaxTotalTokens: 500_000,
    subAgentMaxFileReads: 50,
  },
  updates: {
    startup: true,
  },
  appearance: {
    fontSize: 14,
    mono: "",
    sans: "",
    terminal: "",
  },
  keybinds: {},
  permissions: {
    autoApprove: false,
  },
  notifications: {
    agent: true,
    permissions: true,
    errors: true,
  },
  sounds: {
    agentEnabled: true,
    agent: "staplebops-01",
    permissionsEnabled: true,
    permissions: "staplebops-02",
    errorsEnabled: true,
    errors: "nope-03",
  },
  logs: {
    retentionDays: 7,
  },
  market: {
    source: "modelscope",
  },
}

function withFallback<T>(read: () => T | undefined, fallback: T) {
  return createMemo(() => read() ?? fallback)
}

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  init: () => {
    const [store, setStore, _, ready] = persisted("settings.v3", createStore<Settings>(defaultSettings))

    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      root.style.setProperty("--font-family-mono", monoFontFamily(store.appearance?.mono))
      root.style.setProperty("--font-family-sans", sansFontFamily(store.appearance?.sans))
      // Wire fontSize to CSS variables for CodeMirror and other consumers
      const size = store.appearance?.fontSize ?? 14
      root.style.setProperty("--editor-font-size", `${size}px`)
      root.style.setProperty("--editor-line-height", `${Math.round(size * 1.8)}px`)
      // Sync global UI font size variables based on the editor font size
      // Ratios mirror the type scale in packages/ui/src/styles/theme.css so the
      // UI keeps its proportions when the editor font size changes.
      root.style.setProperty("--font-size-small", `${Math.round((size * 13) / 14)}px`)
      root.style.setProperty("--font-size-base", `${size}px`)
      root.style.setProperty("--font-size-large", `${Math.round((size * 18) / 14)}px`)
      root.style.setProperty("--font-size-x-large", `${Math.round((size * 22) / 14)}px`)
    })

    return {
      ready,
      get current() {
        return store
      },
      general: {
        autoSave: withFallback(() => store.general?.autoSave, defaultSettings.general.autoSave),
        setAutoSave(value: boolean) {
          setStore("general", "autoSave", value)
        },
        showFileTree: withFallback(() => store.general?.showFileTree, defaultSettings.general.showFileTree),
        setShowFileTree(value: boolean) {
          setStore("general", "showFileTree", value)
        },
        showNavigation: withFallback(() => store.general?.showNavigation, defaultSettings.general.showNavigation),
        setShowNavigation(value: boolean) {
          setStore("general", "showNavigation", value)
        },
        showSearch: withFallback(() => store.general?.showSearch, defaultSettings.general.showSearch),
        setShowSearch(value: boolean) {
          setStore("general", "showSearch", value)
        },
        showStatus: withFallback(() => store.general?.showStatus, defaultSettings.general.showStatus),
        setShowStatus(value: boolean) {
          setStore("general", "showStatus", value)
        },
        showTerminal: withFallback(() => store.general?.showTerminal, defaultSettings.general.showTerminal),
        setShowTerminal(value: boolean) {
          setStore("general", "showTerminal", value)
        },
        showThinking: withFallback(
          () => store.general?.showThinking,
          defaultSettings.general.showThinking,
        ),
        setShowThinking(value: boolean) {
          setStore("general", "showThinking", value)
        },
        shellToolPartsExpanded: withFallback(
          () => store.general?.shellToolPartsExpanded,
          defaultSettings.general.shellToolPartsExpanded,
        ),
        setShellToolPartsExpanded(value: boolean) {
          setStore("general", "shellToolPartsExpanded", value)
        },
        editToolPartsExpanded: withFallback(
          () => store.general?.editToolPartsExpanded,
          defaultSettings.general.editToolPartsExpanded,
        ),
        setEditToolPartsExpanded(value: boolean) {
          setStore("general", "editToolPartsExpanded", value)
        },
        lineWrapping: withFallback(() => store.general?.lineWrapping, defaultSettings.general.lineWrapping),
        setLineWrapping(value: boolean) {
          setStore("general", "lineWrapping", value)
        },
        tabWrapping: withFallback(() => store.general?.tabWrapping, defaultSettings.general.tabWrapping),
        setTabWrapping(value: boolean) {
          setStore("general", "tabWrapping", value)
        },
        syntaxCheck: withFallback(() => store.general?.syntaxCheck, defaultSettings.general.syntaxCheck),
        setSyntaxCheck(value: boolean) {
          setStore("general", "syntaxCheck", value)
        },
        reflect: withFallback(() => store.general?.reflect, defaultSettings.general.reflect),
        setReflect(value: boolean) {
          setStore("general", "reflect", value)
        },
        parallelDispatch: withFallback(
          () => store.general?.parallelDispatch,
          defaultSettings.general.parallelDispatch,
        ),
        setParallelDispatch(value: boolean) {
          setStore("general", "parallelDispatch", value)
        },
        agentMaxSteps: withFallback(
          () => store.general?.agentMaxSteps,
          defaultSettings.general.agentMaxSteps,
        ),
        setAgentMaxSteps(value: number) {
          setStore("general", "agentMaxSteps", value)
        },
      },
      loop: {
        subAgentMaxRounds: withFallback(
          () => store.loop?.subAgentMaxRounds,
          defaultSettings.loop.subAgentMaxRounds,
        ),
        setSubAgentMaxRounds(value: number) {
          setStore("loop", "subAgentMaxRounds", value)
        },
        subAgentTimeoutSecs: withFallback(
          () => store.loop?.subAgentTimeoutSecs,
          defaultSettings.loop.subAgentTimeoutSecs,
        ),
        setSubAgentTimeoutSecs(value: number) {
          setStore("loop", "subAgentTimeoutSecs", value)
        },
        subAgentMaxTotalTokens: withFallback(
          () => store.loop?.subAgentMaxTotalTokens,
          defaultSettings.loop.subAgentMaxTotalTokens,
        ),
        setSubAgentMaxTotalTokens(value: number) {
          setStore("loop", "subAgentMaxTotalTokens", value)
        },
        subAgentMaxFileReads: withFallback(
          () => store.loop?.subAgentMaxFileReads,
          defaultSettings.loop.subAgentMaxFileReads,
        ),
        setSubAgentMaxFileReads(value: number) {
          setStore("loop", "subAgentMaxFileReads", value)
        },
      },
      updates: {
        startup: withFallback(() => store.updates?.startup, defaultSettings.updates.startup),
        setStartup(value: boolean) {
          setStore("updates", "startup", value)
        },
      },
      appearance: {
        fontSize: withFallback(() => store.appearance?.fontSize, defaultSettings.appearance.fontSize),
        setFontSize(value: number) {
          setStore("appearance", "fontSize", value)
        },
        font: withFallback(() => store.appearance?.mono, defaultSettings.appearance.mono),
        setFont(value: string) {
          setStore("appearance", "mono", value.trim() ? value : "")
        },
        uiFont: withFallback(() => store.appearance?.sans, defaultSettings.appearance.sans),
        setUIFont(value: string) {
          setStore("appearance", "sans", value.trim() ? value : "")
        },
        terminalFont: withFallback(() => store.appearance?.terminal, defaultSettings.appearance.terminal),
        setTerminalFont(value: string) {
          setStore("appearance", "terminal", value.trim() ? value : "")
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          setStore("keybinds", (current) => {
            if (!Object.prototype.hasOwnProperty.call(current, action)) return current
            const next = { ...current }
            delete next[action]
            return next
          })
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      permissions: {
        autoApprove: withFallback(() => store.permissions?.autoApprove, defaultSettings.permissions.autoApprove),
        setAutoApprove(value: boolean) {
          setStore("permissions", "autoApprove", value)
        },
      },
      notifications: {
        agent: withFallback(() => store.notifications?.agent, defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setStore("notifications", "agent", value)
        },
        permissions: withFallback(() => store.notifications?.permissions, defaultSettings.notifications.permissions),
        setPermissions(value: boolean) {
          setStore("notifications", "permissions", value)
        },
        errors: withFallback(() => store.notifications?.errors, defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setStore("notifications", "errors", value)
        },
      },
      sounds: {
        agentEnabled: withFallback(() => store.sounds?.agentEnabled, defaultSettings.sounds.agentEnabled),
        setAgentEnabled(value: boolean) {
          setStore("sounds", "agentEnabled", value)
        },
        agent: withFallback(() => store.sounds?.agent, defaultSettings.sounds.agent),
        setAgent(value: string) {
          setStore("sounds", "agent", value)
        },
        permissionsEnabled: withFallback(
          () => store.sounds?.permissionsEnabled,
          defaultSettings.sounds.permissionsEnabled,
        ),
        setPermissionsEnabled(value: boolean) {
          setStore("sounds", "permissionsEnabled", value)
        },
        permissions: withFallback(() => store.sounds?.permissions, defaultSettings.sounds.permissions),
        setPermissions(value: string) {
          setStore("sounds", "permissions", value)
        },
        errorsEnabled: withFallback(() => store.sounds?.errorsEnabled, defaultSettings.sounds.errorsEnabled),
        setErrorsEnabled(value: boolean) {
          setStore("sounds", "errorsEnabled", value)
        },
        errors: withFallback(() => store.sounds?.errors, defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
      },
      logs: {
        retentionDays: withFallback(() => store.logs?.retentionDays, defaultSettings.logs.retentionDays),
        setRetentionDays(value: number) {
          setStore("logs", "retentionDays", value)
        },
      },
      market: {
        source: withFallback(() => store.market?.source, defaultSettings.market.source),
        setSource(value: string) {
          setStore("market", "source", value)
        },
      },
    }
  },
})
