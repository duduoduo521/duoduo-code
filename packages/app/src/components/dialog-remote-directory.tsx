import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { formatErrorMessage } from "@/util/format-error-message"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Icon } from "@duoduo-ai/ui/icon"
import { createEffect, createSignal, For, onMount, Show } from "solid-js"

export interface RemoteConnectionOptions {
  host: string
  port: number
  username: string
  auth: "password" | "ssh-key"
  secret: string
  privateKey: string
}

export interface RemoteEntry {
  name: string
  type: "directory" | "file"
  size: number
  mtime: number
}

interface DialogRemoteDirectoryProps {
  remote: RemoteConnectionOptions
  initialDir: string
  onSelect: (dir: string) => void
  onClose: () => void
}

// 加载骨架屏：复用市场/会话列表的同一风格（animate-pulse + surface-raised-base），
// 行结构（图标 + 单行文本）与真实目录行对齐，撑满固定列表区。
const SKELETON_WIDTHS = ["w-1/2", "w-2/5", "w-1/3", "w-3/5", "w-1/4"]

function DirectorySkeleton() {
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden py-1">
      <For each={Array.from({ length: 12 }, (_, i) => i)}>
        {(i) => (
          <div class="flex animate-pulse items-center gap-3 rounded-md px-2 py-2">
            <div class="size-5 shrink-0 rounded bg-surface-raised-base" />
            <div
              class={`h-4 rounded bg-surface-raised-base ${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}`}
            />
          </div>
        )}
      </For>
    </div>
  )
}

interface Crumb {
  name: string
  path: string
  /** 当前所在层级（最后一段）：高亮且不可点击 */
  current?: boolean
  /** 折叠占位符（"…"）：点击展开完整路径 */
  ellipsis?: boolean
}

// 折叠时最多显示的段数（根段 + 省略号 + 末尾 3 段）
const MAX_CRUMBS = 5

export function DialogRemoteDirectory(props: DialogRemoteDirectoryProps) {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()

  const normalize = (dir: string) => (dir || "/").replace(/\/+$/, "") || "/"
  const [currentDir, setCurrentDir] = createSignal(normalize(props.initialDir))
  const [entries, setEntries] = createSignal<RemoteEntry[]>([])
  // 初始即为 true：弹窗挂载的第一帧就是骨架屏，而不是先闪一下空列表。
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  // 面包屑中间段是否展开（深路径默认折叠为"根 / … / 末尾段"）
  const [expanded, setExpanded] = createSignal(false)
  // 选中的目录（完整路径）；单击切换选中、再次单击取消。
  // 为空时底部"选择此目录"回退到当前所在目录 currentDir()。
  const [selected, setSelected] = createSignal("")

  // 竞态守卫：快速连点面包屑不同段时会并发多个列目录请求，
  // 只有序号最新的响应才允许落地，防止旧目录覆盖新目录。
  let fetchSeq = 0

  const fetchDir = async (dir: string) => {
    const target = normalize(dir)
    const seq = ++fetchSeq
    setLoading(true)
    setError("")
    // 切换目录后重新折叠面包屑（新路径的中间段重新按需展开）
    setExpanded(false)
    try {
      const client = globalSDK.createClient({})
      const res = await client.project.remoteList({
        host: props.remote.host,
        port: props.remote.port,
        username: props.remote.username,
        auth: props.remote.auth,
        secret: props.remote.secret,
        privateKey: props.remote.privateKey,
        dir: target,
      })
      if (seq !== fetchSeq) return
      if (!res.data) {
        // 透出后端真实错误（如 "ENOENT: ..."、"auth failed" 等），仅在缺失
        // 详细错误时才回退到 i18n 文案。原先只设 i18n 字符串时，对象形式的
        // res.error 会在父级被展开成 "[object Object]"，对用户毫无帮助。
        const detail = formatErrorMessage(res.error)
        setError(detail || language.t("dialog.openProject.remote.listError"))
        setEntries([])
        return
      }
      setEntries(res.data as RemoteEntry[])
      setCurrentDir(target)
    } catch (e: unknown) {
      if (seq !== fetchSeq) return
      setError(formatErrorMessage(e))
      setEntries([])
    } finally {
      if (seq === fetchSeq) setLoading(false)
    }
  }

  // 面包屑导航：点击任意层级段直接跳转到该目录（含加载中切换目标）。
  const navigate = (path: string) => {
    if (!path || path === currentDir()) return
    void fetchDir(path)
  }

  // 把当前路径拆成面包屑段：根("/") + 各级目录，每段携带完整路径。
  const crumbs = (): Crumb[] => {
    const parts = currentDir().split("/").filter(Boolean)
    const list: Crumb[] = [{ name: "/", path: "/" }]
    let acc = ""
    for (const part of parts) {
      acc += "/" + part
      list.push({ name: part, path: acc })
    }
    const last = list[list.length - 1]
    if (last) last.current = true
    return list
  }

  // 展开时显示全部段；折叠时保留根段 + "…" + 末尾段。
  const visibleCrumbs = (): Crumb[] => {
    const all = crumbs()
    if (expanded() || all.length <= MAX_CRUMBS) return all
    const head = all.slice(0, 1)
    const tail = all.slice(-(MAX_CRUMBS - 2))
    return [...head, { name: "…", path: "", ellipsis: true }, ...tail]
  }

  // 面包屑横向滚动容器：路径变化/展开后自动滚到最右，保证当前段始终可见。
  let crumbsEl: HTMLDivElement | undefined
  createEffect(() => {
    void currentDir()
    void expanded()
    queueMicrotask(() => {
      if (crumbsEl) crumbsEl.scrollLeft = crumbsEl.scrollWidth
    })
  })

  const enterDir = (name: string) => {
    const base = currentDir()
    const next = base === "/" ? `/${name}` : `${base}/${name}`
    // 进入新目录后，旧的选中（基于上一目录的视图）失效。
    setSelected("")
    void fetchDir(next)
  }

  // 单击目录：切换选中（再次单击同一项取消）。选中态用完整路径，
  // 避免进入不同目录后仅凭名字拼接产生歧义。
  const toggleSelect = (name: string) => {
    const base = currentDir()
    const path = base === "/" ? `/${name}` : `${base}/${name}`
    setSelected((cur) => (cur === path ? "" : path))
  }

  const selectHere = () => {
    // 有选中项时用选中目录；否则回退到当前所在目录。
    props.onSelect(selected() || currentDir())
  }

  // 打开即测试连通性：首次加载会尝试连接并列出根/初始目录，
  // 连不上时错误会直接显示，用户无需先点任何按钮。
  onMount(() => {
    void fetchDir(currentDir())
  })

  const crumbItemClass =
    "shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-12-regular"

  return (
    <Dialog
      title={language.t("dialog.openProject.remote.browseTitle")}
      // 固定尺寸（800×600）：打开即最终大小，不随数据加载撑开；
      // footer 钉在底部，header 与 footer 之间为列表区，在区域内滚动。
      size="large"
      closeAction={props.onClose}
      footer={
        <div class="flex w-full items-center justify-end gap-2 border-t border-border-base px-4 py-3">
          <button
            class="rounded-md border border-border-base px-3 py-2 text-14-regular text-text-strong hover:bg-surface-weak"
            onClick={props.onClose}
          >
            {language.t("common.cancel")}
          </button>
          <button
            class="rounded-md bg-surface-weak px-4 py-2 text-14-medium text-text-strong hover:bg-surface-hover"
            onClick={selectHere}
          >
            {language.t("dialog.openProject.remote.selectHere")}
          </button>
        </div>
      }
    >
      <div class="flex min-h-0 flex-1 flex-col">
        {/* 面包屑工具栏：完整导航，点击任意层级段直达 */}
        <div class="flex shrink-0 items-center border-b border-border-base px-4 py-2">
          <div
            ref={(el) => (crumbsEl = el)}
            class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto no-scrollbar"
          >
            <For each={visibleCrumbs()}>
              {(crumb, i) => (
                <>
                  <Show when={i() > 0}>
                    <Icon name="chevron-right" class="size-3 shrink-0 text-text-weak" />
                  </Show>
                  <Show
                    when={crumb.ellipsis}
                    fallback={
                      <Show
                        when={crumb.current}
                        fallback={
                          <button
                            type="button"
                            class={`${crumbItemClass} text-text-base hover:bg-surface-weak hover:text-text-strong`}
                            onClick={() => navigate(crumb.path)}
                          >
                            {crumb.name}
                          </button>
                        }
                      >
                        <span class={`${crumbItemClass} text-12-medium text-text-strong`}>
                          {crumb.name}
                        </span>
                      </Show>
                    }
                  >
                    <button
                      type="button"
                      class={`${crumbItemClass} text-text-base hover:bg-surface-weak hover:text-text-strong`}
                      title={language.t("dialog.openProject.remote.showFull")}
                      onClick={() => setExpanded(true)}
                    >
                      …
                    </button>
                  </Show>
                </>
              )}
            </For>
          </div>
        </div>

        <div class="flex min-h-0 flex-1 flex-col px-4 py-3">
          <Show when={error()}>
            <div class="mb-2 shrink-0 rounded-md bg-surface-critical-weak px-3 py-2 text-12-regular text-text-on-critical-base">
              {error()}
            </div>
          </Show>
          <Show when={!loading()} fallback={<DirectorySkeleton />}>
            <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <Show
                when={entries().length > 0}
                fallback={
                  <div class="px-1 py-2 text-12-regular text-text-base">
                    {language.t("dialog.openProject.remote.empty")}
                  </div>
                }
              >
                <For each={entries()}>
                  {(item) => {
                    const isDir = item.type === "directory"
                    const itemPath = () => {
                      const base = currentDir()
                      return base === "/" ? `/${item.name}` : `${base}/${item.name}`
                    }
                    return (
                      <button
                        type="button"
                        class={
                          "flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-14-regular " +
                          (isDir && selected() === itemPath()
                            ? "bg-surface-weak text-text-strong"
                            : "text-text-strong hover:bg-surface-weak")
                        }
                        onClick={() => {
                          if (isDir) toggleSelect(item.name)
                        }}
                        onDblClick={() => {
                          if (isDir) enterDir(item.name)
                        }}
                      >
                        <span>{item.name}</span>
                        <span class="text-12-regular text-text-base">
                          {isDir ? "/" : ""}
                        </span>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
