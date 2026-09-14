import { Component } from "solid-js"
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
    smartLayer.api
      ?.post("/agent/loop_config", {
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
