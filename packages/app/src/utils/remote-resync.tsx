import { For, Show, createSignal } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Button } from "@duoduo-ai/ui/button"
import { showToast } from "@duoduo-ai/ui/toast"
import { errorMessage } from "@/context/file/error-message"

type SDKValue = ReturnType<typeof useSDK>
type GlobalSyncValue = ReturnType<typeof useGlobalSync>
type DialogValue = ReturnType<typeof useDialog>
type LangValue = { t: (k: string) => string }

/**
 * Structured view of the SDK surface needed for syncing. We only require
 * `directory` and `createClient` so the same helper works both from components
 * that hold a full `useSDK()` value and from the titlebar (which has no
 * `SDKProvider` ancestor and must pass `globalSDK.createClient` instead).
 */
type SyncSDK = Pick<SDKValue, "directory" | "createClient">

/**
 * Single shared busy signal. All sync entry points (titlebar, file tabs,
 * re-sync) funnel through {@link syncRemote}, so the signal is naturally unique
 * and makes the three entry points mutually exclusive and lets the file tree
 * lock itself during a sync.
 */
const [remoteSyncState, setRemoteSyncState] = createSignal<"push" | "pull" | undefined>(undefined)
export function remoteSyncStatus() {
  return remoteSyncState()
}

export function getRemoteProjectID(
  sdk: SyncSDK,
  globalSync: GlobalSyncValue,
): string | undefined {
  const [child] = globalSync.child(sdk.directory)
  const id = child?.project
  return id?.startsWith("remote:") ? id : undefined
}

/**
 * git-style 3-choice conflict resolver. The two action buttons are bound
 * literally to their direction — `onPull` overwrites local with remote,
 * `onPush` overwrites remote with local. `mode` is intentionally NOT used to
 * dispatch, which removes the old bug where both buttons ran the previously
 * failed direction (3h). `onPush`/`onPull` are wired with `force: true` so the
 * user's choice wins.
 */
export function showSyncConflictDialog(
  conflicts: string[],
  deps: {
    language: LangValue
    dialog: DialogValue
    onPush: () => void
    onPull: () => void
  },
) {
  const { language, dialog, onPush, onPull } = deps
  dialog.show(() => (
    <Dialog title={language.t("remote.conflictTitle") || "同步冲突"} size="normal">
      <div class="flex flex-col gap-4 px-[var(--dialog-gutter)] pb-5 pt-4">
        <p class="text-13-regular text-text-weak">
          {language.t("remote.conflictDesc") ||
            `检测到 ${conflicts.length} 个文件存在本地与远端冲突：`}
        </p>
        <ul class="max-h-40 overflow-auto rounded-md border border-border-weak-base bg-background-base px-3 py-2 text-12-regular font-mono text-text-strong">
          <For each={conflicts}>{(c) => <li>{c}</li>}</For>
        </ul>
        <div class="flex items-center justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("remote.conflictCancel") || "取消"}
          </Button>
          <Button
            variant="secondary"
            size="large"
            onClick={() => {
              dialog.close()
              onPull()
            }}
          >
            {language.t("remote.conflictPull") || "以远端为准拉取覆盖"}
          </Button>
          <Button
            variant="primary"
            size="large"
            onClick={() => {
              dialog.close()
              onPush()
            }}
          >
            {language.t("remote.conflictPush") || "以本地为准推回"}
          </Button>
        </div>
      </div>
    </Dialog>
  ))
}

/**
 * The single entry point for pushing local changes to, or pulling remote
 * changes into, a Plan C remote project. Handles the conflict dialog and
 * success/error toasts, so callers only pass the direction and their context
 * values — no per-caller try/catch or conflict mapping needed.
 */
export async function syncRemote(
  mode: "push" | "pull",
  deps: {
    sdk: SyncSDK
    language: LangValue
    globalSync: GlobalSyncValue
    dialog: DialogValue
    force?: boolean
  },
) {
  const { sdk, language, globalSync, dialog, force } = deps
  // Single-flight guard. The three entry points (titlebar, file tabs, conflict
  // dialog) share this one signal; without the guard two overlapping runs would
  // clear each other's busy state in `finally`, re-enabling the buttons and
  // unlocking the file tree while a sync is still in flight.
  if (remoteSyncState() !== undefined) return
  const projectID = getRemoteProjectID(sdk, globalSync)
  if (!projectID) return
  setRemoteSyncState(mode)
  try {
    const client = sdk.createClient({ directory: sdk.directory })
    const res = mode === "push"
      ? await client.project.pushRemote({ projectID, force: force ?? false })
      : await client.project.pullRemote({ projectID, force: force ?? false })
    const conflicts = res.data?.conflicts ?? []
    if (conflicts.length) {
      showSyncConflictDialog(conflicts, {
        language,
        dialog,
        // Re-run in the chosen direction with force so the conflict is resolved.
        onPush: () => void syncRemote("push", { ...deps, force: true }),
        onPull: () => void syncRemote("pull", { ...deps, force: true }),
      })
      return
    }
    // Push-side partial success: files the remote refused to delete (e.g. a
    // BT-panel locked .user.ini) are reported instead of silently ignored.
    const skipped =
      mode === "push" ? (res.data as { skipped?: string[] } | undefined)?.skipped ?? [] : []
    if (skipped.length) {
      const list = skipped.slice(0, 5).join("\n") + (skipped.length > 5 ? `\n…` : "")
      showToast({
        variant: "error",
        title: language.t("remote.pushSkippedTitle") || "已推回远端，但部分文件未能删除",
        description:
          (language.t("remote.pushSkippedDesc") || "") + (list ? `\n${list}` : ""),
      })
      return
    }
    showToast({
      variant: "success",
      title: language.t(mode === "pull" ? "remote.pullSuccess" : "remote.pushSuccess") ||
        (mode === "pull" ? "已从远端拉取" : "已推回远端"),
      description: language.t(mode === "pull" ? "remote.pullSuccessDesc" : "remote.pushSuccessDesc") || "",
    })
  } catch (e) {
    // createDuoDuoClient() pins throwOnError to true, so HTTP 4xx/5xx land here as
    // the *parsed response body* — a plain object like { error: "..." }, never an
    // Error instance. errorMessage() unwraps it (Bug 1).
    showToast({
      variant: "error",
      title: language.t(mode === "pull" ? "remote.pullFailed" : "remote.pushFailed") ||
        (mode === "pull" ? "拉取远端失败" : "推回远端失败"),
      description: errorMessage(e, language.t("common.requestFailed") || "请求失败"),
    })
  } finally {
    setRemoteSyncState(undefined)
  }
}
