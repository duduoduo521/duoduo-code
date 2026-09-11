import { createMemo, For, Match, Switch } from "solid-js"
import { Button } from "@duoduo-ai/ui/button"
import { Splash } from "@duoduo-ai/ui/logo"
import { useLayout } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@duoduo-ai/shared/util/encode"
import { Icon } from "@duoduo-ai/ui/icon"
import { DateTime } from "luxon"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useServer } from "@/context/server"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { displayName } from "@/pages/layout/helpers"
import { showToast } from "@duoduo-ai/ui/toast"

export default function Home() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const command = useCommand()
  const recent = createMemo(() => {
    return sync.data.project
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })

  // "Ember" — how much warmth a project still has from its last activity.
  // 1 = used moments ago, 0 = a day old or older. The curve is deliberately
  // steeper than linear (exponent 2.2): only genuinely recent work glows, so
  // the effect stays a signal instead of becoming a gradient on every row.
  const DAY_MS = 86_400_000
  const emberFor = (project: (typeof sync.data.project)[number]) => {
    const at = project.time.updated ?? project.time.created
    const age = Date.now() - at
    if (!Number.isFinite(age) || age <= 0) return 1
    if (age >= DAY_MS) return 0
    return Math.round((1 - age / DAY_MS) ** 2.2 * 1000) / 1000
  }

  const serverDotClass = createMemo(() => {
    const healthy = server.healthy()
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  async function openProject(directory: string) {
    // For saved remote (Plan C) projects, show the opening overlay and probe
    // SSH reachability first. A dead server must not mount an empty session —
    // drop the overlay and bounce back with a toast.
    if (directory.startsWith("remote:")) {
      layout.setOpeningRemote(true)
      // [TRACE] 临时诊断：远程打开兜底超时，避免永久「卡在项目加载中」。定位后删除。
      const guard = setTimeout(() => {
        if (layout.openingRemote()) {
          layout.setOpeningRemote(false)
          showToast({
            variant: "error",
            title: language.t("project.remote.openFailed.title"),
            description: "打开项目超时：后端未在规定时间内就绪，请检查 duoduocode 侧车进程。",
          })
        }
      }, 20000)
      void guard
    }
    const probe = await layout.projects.checkRemote(directory)
    if (!probe.ok) {
      layout.setOpeningRemote(false)
      showToast({
        variant: "error",
        title: language.t("project.remote.openFailed.title"),
        description: probe.error ?? language.t("project.remote.openFailed.description"),
      })
      return
    }
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  return (
    <div class="mx-auto mt-55 w-full md:w-auto px-4">
      <Splash class="block mx-auto" style={{ width: "80%", "max-width": "240px" }} />
      <div class="flex items-center justify-center gap-2 mt-4">
        <Button
          size="large"
          variant="ghost"
          class="text-14-regular text-text-weak"
          onClick={() => dialog.show(() => <DialogSelectServer />)}
        >
          <div
            classList={{
              "size-2 rounded-full": true,
              [serverDotClass()]: true,
            }}
          />
          {server.name}
        </Button>
      </div>
      <Switch>
        <Match when={sync.data.project.length > 0}>
          <div class="mt-20 w-full flex flex-col gap-4">
            <div class="flex gap-2 items-center justify-between pl-3">
              <div class="text-14-medium text-text-strong">{language.t("home.recentProjects")}</div>
              <Button icon="folder-add-left" size="normal" class="pl-2 pr-3" onClick={() => command.trigger("project.open")}>
                {language.t("command.project.open")}
              </Button>
            </div>
            <ul class="flex flex-col gap-2">
              <For each={recent()}>
                {(project) => (
                  <Button
                    size="large"
                    variant="ghost"
                    class="project-ember text-14-mono text-left justify-between px-3 gap-3"
                    style={{ "--ember": emberFor(project) }}
                    onClick={() => openProject(project.worktree)}
                  >
                    <span class="flex-1 min-w-0 truncate">
                      {displayName(project)}
                    </span>
                    <div class="shrink-0 text-14-regular text-text-weak">
                      {DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()}
                    </div>
                  </Button>
                )}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={!sync.ready}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
            <Button class="px-3" onClick={() => command.trigger("project.open")}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">{language.t("home.empty.title")}</div>
              <div class="text-12-regular text-text-weak">{language.t("home.empty.description")}</div>
            </div>
            <Button class="px-3 mt-1" onClick={() => command.trigger("project.open")}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
