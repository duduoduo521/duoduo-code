/**
 * Update Status Indicator — shows update progress in the titlebar.
 *
 * Displays a download icon next to the Smart Layer indicator.
 * Hover shows "Downloading…" or "Update downloaded, restart to install".
 * Clicking when downloaded triggers updateAndRestart.
 */

import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { Tooltip } from "@duoduo-ai/ui/tooltip"

export function UpdateStatusIndicator() {
  const platform = usePlatform()
  const language = useLanguage()

  const status = () => platform.updateStatus?.() ?? "none"
  const version = () => platform.updateVersion?.() ?? ""

  const tooltipText = () => {
    switch (status()) {
      case "checking":
        return language.t("update.status.checking")
      case "downloading":
        return language.t("update.status.downloading")
      case "downloaded":
        return language.t("update.status.downloaded", { version: version() })
      case "error":
        return language.t("update.status.error")
      default:
        return ""
    }
  }

  const handleClick = () => {
    if (status() === "downloaded" && platform.updateAndRestart) {
      void platform.updateAndRestart()
    }
  }

  return (
    <Show when={status() !== "none"}>
      <Tooltip value={tooltipText()}>
        <button
          data-component="update-status"
          class="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs text-text-weak hover:bg-background-stronger transition-colors"
          onClick={handleClick}
          type="button"
        >
          <Show
            when={status() === "downloading" || status() === "checking"}
            fallback={<span class="inline-block h-1.5 w-1.5 rounded-full bg-icon-info-base" data-update-status={status()} />}
          >
            <span
              class="inline-block h-1.5 w-1.5 rounded-full bg-icon-warning-base animate-pulse"
              data-update-status={status()}
            />
          </Show>
          <Show when={status() === "downloading" || status() === "checking"}>
            <span>{language.t("update.status.downloadingShort")}</span>
          </Show>
          <Show when={status() === "downloaded"}>
            <span>{language.t("update.status.label")}</span>
          </Show>
        </button>
      </Tooltip>
    </Show>
  )
}
