import { check } from "@tauri-apps/plugin-updater"

export const UPDATER_ENABLED = window.__DUODUO__?.updaterEnabled ?? false

/** Re-export the Tauri updater check function for use in index.tsx */
export { check }
