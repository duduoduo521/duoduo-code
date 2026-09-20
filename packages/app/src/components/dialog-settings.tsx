import { Component } from "solid-js"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Tabs } from "@duoduo-ai/ui/tabs"
import { Icon } from "@duoduo-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneral } from "./settings-general"
import { SettingsLoop } from "./settings-loop"
import { SettingsLogs } from "./settings-logs"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsProviders } from "./settings-providers"
import { SettingsGear } from "./settings-gear"
import { SettingsIm } from "./settings-im"
import { SettingsStorage } from "./settings-storage"
import { SettingsSnapshot } from "./settings-snapshot"
import { SettingsConcurrency } from "./settings-concurrency"
import { SettingsGraph } from "./settings-graph"
import { SettingsWebfetch } from "./settings-webfetch"

export const DialogSettings: Component<{ initialTab?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()

  return (
    <Dialog size="x-large" transition>
      <Tabs orientation="vertical" variant="settings" defaultValue={props.initialTab ?? "general"} class="h-full settings-dialog">
        <Tabs.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full pt-3">
              <div class="flex flex-col gap-1.5">
                <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                <div class="flex flex-col gap-1.5 w-full">
                  <Tabs.Trigger value="general">
                    <Icon name="sliders" />
                    {language.t("settings.tab.general")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="loop">
                    <Icon name="task" />
                    {language.t("settings.tab.loop")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="shortcuts">
                    <Icon name="keyboard" />
                    {language.t("settings.tab.shortcuts")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="logs">
                    <Icon name="file-tree" />
                    {language.t("settings.tab.logs")}
                  </Tabs.Trigger>
                </div>
              </div>

              <div class="flex flex-col gap-1.5">
                <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                <div class="flex flex-col gap-1.5 w-full">
                  <Tabs.Trigger value="providers">
                    <Icon name="providers" />
                    {language.t("settings.providers.title")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="gear">
                    <Icon name="task" />
                    {language.t("settings.tab.gearMarket")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="im">
                    <Icon name="bubble-5" />
                    {language.t("settings.im.title")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="storage">
                    <Icon name="server" />
                    {language.t("settings.storage.title")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="snapshot">
                    <Icon name="file-tree" />
                    {language.t("settings.snapshot.title")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="concurrency">
                    <Icon name="sliders" />
                    {language.t("settings.concurrency.title")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="graph">
                    <Icon name="graph-kanban" />
                    {language.t("settings.graph.title")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="webfetch">
                    <Icon name="sliders" />
                    {language.t("settings.webfetch.title")}
                  </Tabs.Trigger>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-11-regular">v{platform.version?.()}</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar overflow-y-auto">
          <SettingsGeneral />
        </Tabs.Content>
        <Tabs.Content value="loop" class="no-scrollbar overflow-y-auto">
          <SettingsLoop />
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar overflow-y-auto">
          <SettingsKeybinds />
        </Tabs.Content>
        <Tabs.Content value="logs" class="no-scrollbar overflow-y-auto">
          <SettingsLogs />
        </Tabs.Content>
        <Tabs.Content value="providers" class="no-scrollbar overflow-y-auto">
          <SettingsProviders />
        </Tabs.Content>
        <Tabs.Content value="gear" class="no-scrollbar overflow-y-auto">
          <SettingsGear />
        </Tabs.Content>
        <Tabs.Content value="im" class="no-scrollbar overflow-y-auto">
          <SettingsIm />
        </Tabs.Content>
        <Tabs.Content value="storage" class="no-scrollbar overflow-y-auto">
          <SettingsStorage />
        </Tabs.Content>
        <Tabs.Content value="snapshot" class="no-scrollbar overflow-y-auto">
          <SettingsSnapshot />
        </Tabs.Content>
        <Tabs.Content value="concurrency" class="no-scrollbar overflow-y-auto">
          <SettingsConcurrency />
        </Tabs.Content>
        <Tabs.Content value="graph" class="no-scrollbar overflow-y-auto">
          <SettingsGraph />
        </Tabs.Content>
        <Tabs.Content value="webfetch" class="no-scrollbar overflow-y-auto">
          <SettingsWebfetch />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
