/**
 * Smart Layer Status Indicator — shows connection status in the titlebar.
 *
 * Displays a small dot + label indicating whether the duo-smart-layer
 * sidecar is connected, disconnected, or checking.
 *
 * When disconnected, clicking the indicator triggers a health re-check.
 */

import { Show } from "solid-js"
import { useSmartLayer } from "./context"
import { useLanguage } from "../../context/language"
import { Tooltip } from "@duoduo-ai/ui/tooltip"

export function SmartLayerStatusIndicator() {
  const sl = useSmartLayer()
  const language = useLanguage()

  const statusLabel = () => {
    switch (sl.status) {
      case "connected":
        return language.t("smartLayer.status.connected")
      case "disconnected":
        return language.t("smartLayer.status.disconnected")
      case "checking":
        return language.t("smartLayer.status.checking")
    }
  }

  const dotColor = () => {
    switch (sl.status) {
      case "connected":
        return "bg-green-500"
      case "disconnected":
        return "bg-red-400"
      case "checking":
        return "bg-yellow-400 animate-pulse"
    }
  }

  const tooltipText = () => {
    if (sl.status === "connected" && sl.version) {
      return `${language.t("smartLayer.status.connected")} (v${sl.version})`
    }
    return statusLabel()
  }

  return (
    <Show when={sl.status === "disconnected"}>
      <Tooltip value={tooltipText()}>
        <button
          data-component="smart-layer-status"
          class="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs text-text-weak hover:bg-background-stronger transition-colors"
          onClick={() => sl.checkHealth()}
          type="button"
        >
          <span class={`inline-block h-1.5 w-1.5 rounded-full ${dotColor()}`} data-smart-layer-status={sl.status} />
          <Show when={sl.status === "connected"}>
            <span>{language.t("smartLayer.label")}</span>
          </Show>
        </button>
      </Tooltip>
    </Show>
  )
}
