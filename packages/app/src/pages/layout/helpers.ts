import { getFilename } from "@duoduo-ai/shared/util/path"
import { base64Decode } from "@duoduo-ai/shared/util/encode"
import { type Session } from "@duoduo-ai/sdk/v2/client"
import { useParams } from "@solidjs/router"
import { type Accessor, createMemo } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"

type SessionStore = {
  session?: Session[]
  path: { directory: string }
}

/**
 * True while the sidebar must ignore clicks.
 *
 * Two sources, OR-ed:
 * 1. A project switch/open navigation is in flight (`layout.projectNavigating`,
 *    set around `navigateToProject`) — closes the window between "route
 *    changed" and "data bootstrap started" where a second click would
 *    interleave two open flows.
 * 2. The current route's directory child store is still `"loading"` — covers
 *    the whole project boot (sidecar starting + data bootstrap). This is the
 *    same condition the session page gates its content on.
 *
 * The context menu is intentionally NOT blocked: blocking a right-click menu
 * is a bigger UX loss than the interleaving risk it closes.
 */
export function useSidebarLocked(): Accessor<boolean> {
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const params = useParams()
  return createMemo(() => {
    if (layout.projectNavigating()) return true
    const dir = params.dir ? base64Decode(params.dir) : undefined
    if (!dir) return false
    return globalSync.child(dir, { bootstrap: false })[0].status === "loading"
  })
}

export const workspaceKey = (directory: string) => {
  let value = directory.replaceAll("\\", "/")
  // Normalize Windows drive letter to uppercase so that
  // "c:/Users/test" and "C:/Users/test" produce the same key.
  value = value.replace(/^([a-zA-Z]:)/, (_, drive) => drive.toUpperCase())
  const drive = value.match(/^([A-Za-z]:)\/+$/)
  if (drive) return `${drive[1]}/`
  if (/^\/+$/i.test(value)) return "/"
  return value.replace(/\/+$/, "")
}

function sortSessions(now: number) {
  const oneMinuteAgo = now - 60 * 1000
  return (a: Session, b: Session) => {
    const aUpdated = a.time.updated ?? a.time.created
    const bUpdated = b.time.updated ?? b.time.created
    const aRecent = aUpdated > oneMinuteAgo
    const bRecent = bUpdated > oneMinuteAgo
    if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    return bUpdated - aUpdated
  }
}

const isRootVisibleSession = (session: Session, directory: string) =>
  workspaceKey(session.directory) === workspaceKey(directory) && !session.parentID && !session.time?.archived

export const roots = (store: SessionStore) =>
  (store.session ?? []).filter((session) => isRootVisibleSession(session, store.path.directory))

export const sortedRootSessions = (store: SessionStore, now: number) => roots(store).sort(sortSessions(now))

export const latestRootSession = (stores: SessionStore[], now: number) =>
  stores.flatMap(roots).sort(sortSessions(now))[0]

export function hasProjectPermissions<T>(
  request: Record<string, T[] | undefined> | undefined,
  include: (item: T) => boolean = () => true,
) {
  return Object.values(request ?? {}).some((list) => list?.some(include))
}

export const childSessionOnPath = (sessions: Session[] | undefined, rootID: string, activeID?: string) => {
  if (!activeID || activeID === rootID) return
  const map = new Map((sessions ?? []).map((session) => [session.id, session]))
  let id = activeID

  while (id) {
    const session = map.get(id)
    if (!session?.parentID) return
    if (session.parentID === rootID) return session
    id = session.parentID
  }
}

export const displayName = (project: {
  name?: string
  worktree: string
  remote?: { host: string; remotePath?: string }
}) => {
  if (project.name) return project.name
  if (project.remote) {
    const segment = project.remote.remotePath?.split("/").filter(Boolean).pop()
    return segment || project.remote.host
  }
  return getFilename(project.worktree)
}

export const errorMessage = (err: unknown, fallback: string) => {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}

export const effectiveWorkspaceOrder = (local: string, dirs: string[], persisted?: string[]) => {
  const root = workspaceKey(local)
  const live = new Map<string, string>()

  for (const dir of dirs) {
    const key = workspaceKey(dir)
    if (key === root) continue
    if (!live.has(key)) live.set(key, dir)
  }

  if (!persisted?.length) return [local, ...live.values()]

  const result = [local]
  for (const dir of persisted) {
    const key = workspaceKey(dir)
    if (key === root) continue
    const match = live.get(key)
    if (!match) continue
    result.push(match)
    live.delete(key)
  }

  return [...result, ...live.values()]
}
