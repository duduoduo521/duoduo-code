import type { Session } from "@duoduo-ai/sdk/v2/client"
import { Avatar } from "@duoduo-ai/ui/avatar"
import { Icon } from "@duoduo-ai/ui/icon"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { Spinner } from "@duoduo-ai/ui/spinner"
import { Tooltip } from "@duoduo-ai/ui/tooltip"
import { getFilename } from "@duoduo-ai/shared/util/path"
import { A, useParams } from "@solidjs/router"
import { type Accessor, createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { produce } from "solid-js/store"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { APP_DOMAIN } from "@/config/domains"
import { getAvatarColors, type LocalProject, useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { childSessionOnPath, hasProjectPermissions } from "./helpers"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { Button } from "@duoduo-ai/ui/button"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { showToast } from "@duoduo-ai/ui/toast"
import { TextField } from "@duoduo-ai/ui/text-field"

const DUODUO_PROJECT_ID = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"
const DEFAULT_PROJECT_LOGO = "/logo-2000.png"

export function getProjectAvatarSource(
  id?: string,
  icon?: { color?: string; url?: string; override?: string },
  fallbackLogo?: string,
) {
  // 有 logo（override 手动设置 / url 自动发现）时优先显示 logo。
  // 否则回退：duoduo 项目用其 favicon；其余项目用 fallbackLogo（sidebar 传入固定 logo，
  // 用于替代默认字母头像）；当 fallbackLogo 为空（如编辑弹窗）则回退到字母 + 颜色背景。
  if (icon?.override || icon?.url) return icon.override ?? icon.url
  if (id === DUODUO_PROJECT_ID) return `${APP_DOMAIN}/favicon.svg`
  return fallbackLogo
}

export const ProjectIcon = (props: { project: LocalProject; class?: string; notify?: boolean }): JSX.Element => {
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const permission = usePermission()
  const dirs = createMemo(() => [props.project.worktree, ...(props.project.sandboxes ?? [])])
  const unseenCount = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const hasError = createMemo(() => dirs().some((directory) => notification.project.unseenHasError(directory)))
  const hasPermissions = createMemo(() =>
    dirs().some((directory) => {
      const [store] = globalSync.child(directory, { bootstrap: false })
      return hasProjectPermissions(store.permission, (item) => !permission.autoResponds(item, directory))
    }),
  )
  const notify = createMemo(() => props.notify && (hasPermissions() || unseenCount() > 0))
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))

  return (
    <div class={`relative size-full shrink-0 rounded ${props.class ?? ""}`}>
      <div class="size-full rounded overflow-clip">
        <Avatar
          fallback={name()}
          src={getProjectAvatarSource(props.project.id, props.project.icon, DEFAULT_PROJECT_LOGO)}
          {...getAvatarColors(props.project.icon?.color)}
          class="size-full rounded avatar-flush"
          classList={{ "badge-mask": notify() }}
        />
      </div>
      <Show when={notify()}>
        <div
          classList={{
            "absolute top-px right-px size-1.5 rounded-full z-10": true,
            "bg-surface-warning-strong": hasPermissions(),
            "bg-icon-critical-base": !hasPermissions() && hasError(),
            "bg-text-interactive-base": !hasPermissions() && !hasError(),
          }}
        />
      </Show>
    </div>
  )
}

export type SessionItemProps = {
  session: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  mobile?: boolean
  dense?: boolean
  showTooltip?: boolean
  showChild?: boolean
  level?: number
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
}

const SessionRow = (props: {
  session: Session
  slug: string
  mobile?: boolean
  dense?: boolean
  tint: Accessor<string | undefined>
  isWorking: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  hasError: Accessor<boolean>
  unseenCount: Accessor<number>
  clearHoverProjectSoon: () => void
  sidebarOpened: Accessor<boolean>
  warmPress: () => void
  warmFocus: () => void
}): JSX.Element => {
  const title = () => sessionTitle(props.session.title)

  return (
    <A
      href={`/${props.slug}/session/${props.session.id}`}
      class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onPointerDown={props.warmPress}
      onFocus={props.warmFocus}
      onClick={() => {
        if (props.sidebarOpened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div
        class="shrink-0 size-6 flex items-center justify-center"
        style={{ color: props.tint() ?? "var(--icon-interactive-base)" }}
      >
        <Switch>
          <Match when={props.isWorking()}>
            <Spinner class="size-[15px]" />
          </Match>
          <Match when={props.hasPermissions()}>
            <div class="size-1.5 rounded-full bg-surface-warning-strong" />
          </Match>
          <Match when={props.hasError()}>
            <div class="size-1.5 rounded-full bg-icon-critical-base" />
          </Match>
          <Match when={props.unseenCount() > 0}>
            <div class="size-1.5 rounded-full bg-text-interactive-base" />
          </Match>
          <Match when={true}>
            <div class="size-1.5 rounded-full bg-surface-success-strong" />
          </Match>
        </Switch>
      </div>
      <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate">{title()}</span>
    </A>
  )
}

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const params = useParams()
  const layout = useLayout()
  const language = useLanguage()
  const dialog = useDialog()
  const notification = useNotification()
  const permission = usePermission()
  const globalSync = useGlobalSync()
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore] = globalSync.child(props.session.directory)
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.session.id, (item) => {
      return !permission.autoResponds(item, props.session.directory)
    })
  })
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    // Mirror session.tsx busy(): server status is authoritative. The backend
    // deletes a session from its status map once idle, so a completed session
    // is absent (undefined) from session_status after the periodic refresh —
    // treat that as idle, never as "working". Local message cache is stale
    // (e.g. missed message.updated during an SSE reconnect) and must not be
    // consulted, otherwise finished sessions show a spinner forever.
    const status = sessionStore.session_status[props.session.id] ?? { type: "idle" as const }
    return status.type === "busy" || status.type === "retry"
  })

  const tint = createMemo(() => messageAgentColor(sessionStore.message[props.session.id], sessionStore.agent))
  const tooltip = createMemo(() => props.showTooltip ?? (props.mobile || !props.sidebarExpanded()))
  const currentChild = createMemo(() => {
    if (!props.showChild) return
    return childSessionOnPath(sessionStore.session, props.session.id, params.id)
  })

  const warm = (span: number, priority: "high" | "low") => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list

    props.prefetchSession(props.session, priority)

    const idx = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (idx === -1) return

    for (let step = 1; step <= span; step++) {
      const next = list[idx + step]
      if (next) props.prefetchSession(next, step === 1 ? "high" : priority)

      const prev = list[idx - step]
      if (prev) props.prefetchSession(prev, step === 1 ? "high" : priority)
    }
  }

  const item = (
    <SessionRow
      session={props.session}
      slug={props.slug}
      mobile={props.mobile}
      dense={props.dense}
      tint={tint}
      isWorking={isWorking}
      hasPermissions={hasPermissions}
      hasError={hasError}
      unseenCount={unseenCount}
      clearHoverProjectSoon={props.clearHoverProjectSoon}
      sidebarOpened={layout.sidebar.opened}
      warmPress={() => warm(2, "high")}
      warmFocus={() => warm(2, "high")}
    />
  )

  return (
    <>
      <div
        data-session-id={props.session.id}
        class="group/session relative w-full min-w-0 rounded-md cursor-default pr-3 transition-colors hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active"
        style={{ "padding-left": `${8 + (props.level ?? 0) * 16}px` }}
      >
        <div class="flex min-w-0 items-center gap-1">
          <div class="min-w-0 flex-1">
            <Show
              when={!tooltip()}
              fallback={
                <Tooltip
                  placement={props.mobile ? "bottom" : "right"}
                  value={sessionTitle(props.session.title)}
                  gutter={10}
                  class="min-w-0 w-full"
                >
                  {item}
                </Tooltip>
              }
            >
              {item}
            </Show>
          </div>

          <Show when={!props.level}>
            <div
              class="shrink-0 flex overflow-hidden transition-[width,opacity]"
              classList={{
                "w-12 opacity-100 pointer-events-auto": !!props.mobile,
                "w-0 opacity-0 pointer-events-none": !props.mobile,
                "group-hover/session:w-12 group-hover/session:opacity-100 group-hover/session:pointer-events-auto": true,
                "group-focus-within/session:w-12 group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto": true,
              }}
            >
              <Tooltip value={language.t("common.rename")} placement="top">
                <IconButton
                  icon="edit"
                  variant="ghost"
                  class="size-6 rounded-md"
                  aria-label={language.t("common.rename")}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    dialog.show(() => <RenameSessionDialog session={props.session} />)
                  }}
                />
              </Tooltip>
              <Tooltip value={language.t("common.archive")} placement="top">
                <IconButton
                  icon="archive"
                  variant="ghost"
                  class="size-6 rounded-md"
                  aria-label={language.t("common.archive")}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void props.archiveSession(props.session)
                  }}
                />
              </Tooltip>
            </div>
          </Show>
        </div>
      </div>
      <Show when={currentChild()} keyed>
        {(child) => (
          <div class="w-full">
            <SessionItem {...props} session={child} level={(props.level ?? 0) + 1} />
          </div>
        )}
      </Show>
    </>
  )
}

const RenameSessionDialog = (props: { session: Session }) => {
  const dialog = useDialog()
  const sdk = useSDK()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const [store, setStore] = globalSync.child(props.session.directory)
  const [draft, setDraft] = createSignal(sessionTitle(props.session.title) ?? props.session.id)
  const save = async () => {
    const next = draft().trim()
    const current = sessionTitle(props.session.title) ?? props.session.id
    if (!next || next === current) {
      dialog.close()
      return
    }
    try {
      await sdk.client.session.update({
        sessionID: props.session.id,
        directory: props.session.directory,
        title: next,
      })
      setStore(
        produce((draftState) => {
          const target = draftState.session.find((x) => x.id === props.session.id)
          if (target) target.title = next
        }),
      )
      dialog.close()
    } catch {
      showToast({ variant: "error", title: language.t("common.renameFailed") })
    }
  }
  return (
    <Dialog title={language.t("common.rename")} class="w-full max-w-[420px] mx-auto">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
        class="flex flex-col gap-4 px-6 pb-6 pt-4"
      >
        <TextField value={draft()} onChange={setDraft} placeholder={language.t("common.rename")} />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large">
            {language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export const NewSessionItem = (props: {
  slug: string
  mobile?: boolean
  dense?: boolean
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
}): JSX.Element => {
  const layout = useLayout()
  const language = useLanguage()
  const label = language.t("command.session.new")
  const tooltip = () => props.mobile || !props.sidebarExpanded()
  const item = (
    <A
      href={`/${props.slug}/session`}
      end
      class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onClick={() => {
        if (layout.sidebar.opened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class="shrink-0 size-6 flex items-center justify-center">
        <Icon name="new-session" size="small" class="text-icon-weak" />
      </div>
      <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate">{label}</span>
    </A>
  )

  return (
    <div class="group/session relative w-full min-w-0 rounded-md cursor-default transition-colors pl-2 pr-3 hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active">
      <Show
        when={!tooltip()}
        fallback={
          <Tooltip placement={props.mobile ? "bottom" : "right"} value={label} gutter={10} class="min-w-0 w-full">
            {item}
          </Tooltip>
        }
      >
        {item}
      </Show>
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-1">
      <For each={items}>
        {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
