import { Component, createEffect } from "solid-js"
import { Icon } from "@duoduo-ai/ui/icon"
import { TextField } from "@duoduo-ai/ui/text-field"
import { Tooltip } from "@duoduo-ai/ui/tooltip"
import { showToast } from "@duoduo-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useSmartLayer } from "@/addons/smart-layer/context"
import { useSettings } from "@/context/settings"
import { SettingsList } from "./settings-list"
import { SettingsPage } from "./settings-page"
import { SettingsRow } from "./settings-row"

/**
 * 循环设置 tab: the main loop's max-steps cap (moved out of 通用) plus the
 * user-configurable sub-agent loop limits (`LoopConfig.sub_agent_*`, applied
 * to `task` children and G7 parallel fan-out).
 *
 * Every change persists to the settings store AND is pushed to the Rust side
 * via `POST /agent/loop_config`, taking effect on the next run_loop.
 */
export const SettingsLoop: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const smartLayer = useSmartLayer()

  const postLoopConfig = () => {
    const api = smartLayer.api
    if (!api) {
      // Never silently drop the push: the Rust side is what the run loop
      // actually enforces, so a dropped push means the UI and the cap diverge.
      showToast({
        title: language.t("toast.loopConfig.failed.title"),
        description: language.t("toast.loopConfig.failed.description"),
        variant: "error",
      })
      return
    }
    api
      .post("/agent/loop_config", {
        maxSteps: settings.general.agentMaxSteps(),
        subAgentMaxRounds: settings.loop.subAgentMaxRounds(),
        subAgentTimeoutSecs: settings.loop.subAgentTimeoutSecs(),
        subAgentMaxTotalTokens: settings.loop.subAgentMaxTotalTokens(),
        subAgentMaxFileReads: settings.loop.subAgentMaxFileReads(),
      })
      .catch(() =>
        showToast({
          title: language.t("toast.loopConfig.failed.title"),
          description: language.t("toast.loopConfig.failed.description"),
          variant: "error",
        }),
      )
  }

  // Read back the Rust-side effective loop config once the smart-layer client
  // is available. The UI only PUSHES values on user change; the Rust side is
  // the single source of truth for what the run loop enforces. Without this
  // readback, a stale config.toml value (or a push that never landed) leaves
  // the UI showing "-1 unlimited" while the loop still caps steps.
  createEffect(() => {
    const api = smartLayer.api
    if (!api) return
    api
      .get<{
        maxSteps: number
        subAgentMaxRounds: number
        subAgentTimeoutSecs: number
        subAgentMaxTotalTokens: number
        subAgentMaxFileReads: number
      }>("/agent/loop_config")
      .then((cfg) => {
        settings.general.setAgentMaxSteps(cfg.maxSteps)
        settings.loop.setSubAgentMaxRounds(cfg.subAgentMaxRounds)
        settings.loop.setSubAgentTimeoutSecs(cfg.subAgentTimeoutSecs)
        settings.loop.setSubAgentMaxTotalTokens(cfg.subAgentMaxTotalTokens)
        settings.loop.setSubAgentMaxFileReads(cfg.subAgentMaxFileReads)
      })
      .catch(() => {
        // Smart layer unreachable (e.g. still booting): keep local values;
        // the next user change re-attempts the push.
      })
  })

  const key = (row: string) => `settings.loop.row.${row}` as Parameters<typeof language.t>[0]

  const rows: Array<{
    titleKey: Parameters<typeof language.t>[0]
    descriptionKey: Parameters<typeof language.t>[0]
    value: () => number
    onChange: (next: number) => void
  }> = [
    {
      titleKey: key("agentMaxSteps"),
      descriptionKey: key("agentMaxSteps.description"),
      value: () => settings.general.agentMaxSteps(),
      onChange: (next) => {
        settings.general.setAgentMaxSteps(next)
        postLoopConfig()
      },
    },
    {
      titleKey: key("subAgentMaxRounds"),
      descriptionKey: key("subAgentMaxRounds.description"),
      value: () => settings.loop.subAgentMaxRounds(),
      onChange: (next) => {
        settings.loop.setSubAgentMaxRounds(next)
        postLoopConfig()
      },
    },
    {
      titleKey: key("subAgentTimeoutSecs"),
      descriptionKey: key("subAgentTimeoutSecs.description"),
      value: () => settings.loop.subAgentTimeoutSecs(),
      onChange: (next) => {
        settings.loop.setSubAgentTimeoutSecs(next)
        postLoopConfig()
      },
    },
    {
      titleKey: key("subAgentMaxTotalTokens"),
      descriptionKey: key("subAgentMaxTotalTokens.description"),
      value: () => settings.loop.subAgentMaxTotalTokens(),
      onChange: (next) => {
        settings.loop.setSubAgentMaxTotalTokens(next)
        postLoopConfig()
      },
    },
    {
      titleKey: key("subAgentMaxFileReads"),
      descriptionKey: key("subAgentMaxFileReads.description"),
      value: () => settings.loop.subAgentMaxFileReads(),
      onChange: (next) => {
        settings.loop.setSubAgentMaxFileReads(next)
        postLoopConfig()
      },
    },
  ]

  return (
    <SettingsPage title={language.t("settings.loop.title")} description={language.t("settings.loop.description")}>
      <SettingsList>
        {rows.map((row) => (
          <SettingsRow
            title={
              <div class="flex items-center gap-2">
                <span>{language.t(row.titleKey)}</span>
                <Tooltip value={language.t(row.descriptionKey)} placement="top">
                  <span class="text-text-weak">
                    <Icon name="help" size="small" />
                  </span>
                </Tooltip>
              </div>
            }
            description={language.t(row.descriptionKey)}
          >
            <div class="w-28">
              <TextField
                type="number"
                min={-1}
                value={String(row.value())}
                onChange={(raw: string) => {
                  // `-1` = unlimited everywhere in this tab. Invalid/NaN input
                  // falls back to -1 to match the backend defaults.
                  const rawN = Math.trunc(Number(raw))
                  row.onChange(Number.isFinite(rawN) ? Math.max(-1, rawN) : -1)
                }}
              />
            </div>
          </SettingsRow>
        ))}
      </SettingsList>
    </SettingsPage>
  )
}
