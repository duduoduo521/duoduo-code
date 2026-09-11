// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import { invoke } from "@tauri-apps/api/core"
import { type as ostype } from "@tauri-apps/plugin-os"
import { createSignal } from "solid-js"
import { commands } from "./bindings"

const OS_NAME = ostype()

const [webviewZoom, setWebviewZoom] = createSignal(1)

const MAX_ZOOM_LEVEL = 10
const MIN_ZOOM_LEVEL = 0.2

const clamp = (value: number) => Math.min(Math.max(value, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL)

const applyZoom = (next: number) => {
  setWebviewZoom(next)
  void invoke("plugin:webview|set_webview_zoom", {
    value: next,
  })
}

window.addEventListener("keydown", (event) => {
  if (!(OS_NAME === "macos" ? event.metaKey : event.ctrlKey)) return

  let newZoom = webviewZoom()

  if (event.key === "-") newZoom -= 0.2
  if (event.key === "=" || event.key === "+") newZoom += 0.2
  if (event.key === "0") newZoom = 1

  applyZoom(clamp(newZoom))
})

// Toggle the webview DevTools window.
// macOS: Cmd+Shift+I  ·  others: Ctrl+Shift+I
// NOTE: on macOS the WKWebView inspector is ONLY available in debug builds
// (`tauri dev`); release builds of WKWebView refuse to open devtools, so this
// is a no-op there. The frontend file error logger (`frontend_errors.log`) is
// the always-available fallback for release debugging. The Rust
// `toggle_devtools` command already handles close/re-open and is a no-op when
// devtools cannot be opened.
window.addEventListener("keydown", (event) => {
  const mod = OS_NAME === "macos" ? event.metaKey : event.ctrlKey
  if (mod && event.shiftKey && (event.key === "I" || event.key === "i" || event.code === "KeyI")) {
    event.preventDefault()
    void commands.toggleDevtools()
  }
})

export { webviewZoom }
