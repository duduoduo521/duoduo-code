import { createSimpleContext } from "@duoduo-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import { ServerConnection } from "./server"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenFilePickerOptions = { title?: string; multiple?: boolean; accept?: string[]; extensions?: string[] }
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type UpdateInfo = { updateAvailable: boolean; version?: string }

export type UpdateStatus = "none" | "checking" | "downloading" | "downloaded" | "error"

export type Platform = {
  /** Platform discriminator */
  platform: "web" | "desktop"

  /** Desktop OS (Tauri only) */
  os?: "macos" | "windows" | "linux"

  /** App version (reactive accessor, resolves asynchronously on desktop) */
  version?: Accessor<string | undefined>

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Restart the app  */
  restart(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string): Promise<void>

  /** Open directory picker dialog (native on Tauri, server-backed on web) */
  openDirectoryPickerDialog?(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>

  /** Open native file picker dialog (Tauri only) */
  openFilePickerDialog?(opts?: OpenFilePickerOptions): Promise<PickerPaths>

  /** Save file picker dialog (Tauri only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Check for updates (Tauri only) */
  checkUpdate?(): Promise<UpdateInfo>

  /** Install update and restart (Tauri only) — combines update + relaunch */
  updateAndRestart?(): Promise<void>

  /** Install updates (Tauri only, legacy — prefer updateAndRestart) */
  update?(): Promise<void>

  /** Reactive update status (Tauri only) */
  updateStatus?: Accessor<UpdateStatus>

  /** Reactive update version (Tauri only) */
  updateVersion?: Accessor<string | undefined>

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Get the configured WSL integration (desktop only) */
  getWslEnabled?(): Promise<boolean>

  /** Set the configured WSL integration (desktop only) */
  setWslEnabled?(config: boolean): Promise<void> | void

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Parse markdown to HTML using native parser (desktop only, returns unprocessed code blocks) */
  parseMarkdown?(markdown: string): Promise<string>

  /** List system font families (desktop only) */
  listSystemFonts?(): Promise<string[]>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  readClipboardImage?(): Promise<File | null>

  /** Start a project-specific sidecar (desktop only) */
  getProjectSidecar?(directory: string): Promise<ServerConnection.Sidecar>

  /** Stop a project-specific sidecar (desktop only) */
  stopProjectSidecar?(directory: string): Promise<void>

  /** Smart layer sidecar configuration (desktop only) */
  smartLayer?:
    | {
        url: string
        username?: string
        password?: string
      }
    | (() => { url: string; username?: string; password?: string } | undefined)
}

export type DisplayBackend = "auto" | "wayland"

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
