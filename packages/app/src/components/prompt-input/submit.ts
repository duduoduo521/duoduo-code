import type { Message, Session } from "@duoduo-ai/sdk/v2/client"
import { showToast } from "@duoduo-ai/ui/toast"
import { base64Encode } from "@duoduo-ai/shared/util/encode"
import { Binary } from "@duoduo-ai/shared/util/binary"
import { useNavigate, useParams } from "@solidjs/router"
import { batch, type Accessor } from "solid-js"
import type { FileSelection } from "@/context/file"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { isProjectTaskBusyError } from "./project-task-busy"
import { promptQueue } from "./queue"
import { isCommandGear, activateGear } from "@/context/gear-store"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  locale?: string
}

type FollowupSendInput = {
  client: ReturnType<typeof useSDK>["client"]
  globalSync: ReturnType<typeof useGlobalSync>
  sync: ReturnType<typeof useSync>
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
  cascadeQA?: Accessor<boolean>
  /** Mirrors `PromptSubmitInput.autoAccept`: whether the user's "auto-accept
   *  permissions" switch is on for this session/directory. Plumbed to Rust so
   *  sub-agents treat `Ask` as `Allow` (option B of the permission refactor). */
  autoAccept?: Accessor<boolean>
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const [, setStore] = input.globalSync.child(input.draft.sessionDirectory)

  const setBusy = () => {
    // Clear any pending abort marker UNCONDITIONALLY. markAborted is set
    // unconditionally in abort() above, so the clear must be too: gated on
    // optimisticBusy, a worktree session (sessionDirectory !== projectDirectory)
    // kept its abort marker forever and event-reducer filtered every future
    // turn's streaming text/reasoning — the "输入后直接断了" rendering symptom.
    input.globalSync.clearAborted(input.draft.sessionID)
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      await input.client.session.command({
        sessionID: input.draft.sessionID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
        parts: images.map((attachment) => ({
          id: Identifier.ascending("part"),
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.dataUrl,
          filename: attachment.filename,
        })),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  // Gear command routing: `/<gear>` → activate endpoint, then send the tail
  // (if any) as a normal follow-up message.
  if (cmd && isCommandGear(cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }
      await activateGear(cmd)
      showToast({
        variant: "success",
        title: `已激活智械 ${cmd}`,
      })
    } catch (err) {
      setIdle()
      throw err
    }
    const tailText = tail.join(" ").trim()
    setIdle()
    if (!tailText) return true
    const tailPrompt: Prompt = [{ type: "text", content: tailText, start: 0, end: tailText.length }]
    return sendFollowupDraft({
      ...input,
      draft: { ...input.draft, prompt: tailPrompt },
    })
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    // Fire promptAsync immediately — it returns 204 and the server processes
    // the prompt in the background. The `before` hook (e.g. waitForWorktree)
    // is started in parallel so it doesn't block the critical path.
    // Once promptAsync returns 204, the prompt is accepted by the server
    // and AI processing begins regardless of the before hook's outcome.
    const beforePromise = wait()

    await input.client.session.promptAsync({
      sessionID: input.draft.sessionID,
      agent: input.draft.agent,
      model: input.draft.model,
      messageID,
      parts: requestParts,
      cascadeQA: input.cascadeQA?.() ?? false,
      locale: input.draft.locale,
      // Honor the user's "auto-accept permissions" switch (option B): when on
      // for this session or directory, sub-agents treat `Ask` as `Allow` so
      // autonomous work isn't blocked by confirmation prompts. `input.autoAccept`
      // is already wired to the permission store (`isAutoAccepting` / directory).
      autoAccept: input.autoAccept?.(),
    })

    // promptAsync succeeded (204) — the prompt is accepted.
    // Await the before hook for cleanup (e.g. worktree state transitions),
    // but since the prompt is already accepted by the server, we keep the
    // optimistic message and let SSE events replace it naturally.
    // AI responses will stream back regardless of the before hook outcome.
    try {
      await beforePromise
    } catch {
      // before hook threw after promptAsync succeeded — prompt is still valid
      // on the server, so keep the optimistic message.
    }

    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  onSubmit?: () => void
  cascadeQA?: Accessor<boolean>
}

type CommentItem = {
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    globalSync.todo.set(sessionID, [])
    const [, setStore] = globalSync.child(sdk.directory)
    setStore("todo", sessionID, [])

    // Immediately set session status to idle so the UI responds
    // instantly to the stop button press, before the HTTP abort
    // request completes.  The server-side abort is fire-and-forget
    // — the frontend should not block interaction on it.
    sync.set("session_status", sessionID, { type: "idle" })

    // Mark session as aborted — event-reducer will filter stale LLM output
    // (text/reasoning parts) until the user sends a new message.
    globalSync.markAborted(sessionID)

    // Mark any assistant message still in flight (no `time.completed`) as
    // interrupted. Otherwise the streaming-created placeholder — whose reasoning
    // was already rendered — stays stuck in the "thinking" state forever after
    // the user clicks stop, because the runLoop cancelled before writing the
    // message to the DB (so `GET messages` never returns a `completed` value).
    // `SessionTurn.interrupted()` keys off `error.name === "MessageAbortedError"`
    // to render the "interrupted" divider instead of a perpetual thinking shimmer.
    const liveMessages = sync.data.message[sessionID] ?? []
    // Target the CURRENT turn's assistant message: the newest assistant message
    // parented under the newest user message, falling back to the session's last
    // assistant message when the parent link is missing. Previously the marker
    // was only applied to messages without `time.completed`, so stopping during
    // a gap where the last round had already been completed left the UI with no
    // feedback at all.
    let lastUserID: string | undefined
    for (let i = liveMessages.length - 1; i >= 0; i--) {
      if (liveMessages[i]!.role === "user") {
        lastUserID = liveMessages[i]!.id
        break
      }
    }
    const reversed = [...liveMessages].reverse()
    const stopTarget =
      (lastUserID
        ? reversed.find((m) => m.role === "assistant" && (m as { parentID?: string }).parentID === lastUserID)
        : undefined) ?? reversed.find((m) => m.role === "assistant")
    if (stopTarget) {
      setStore("message", sessionID, (messages: Message[]) => {
        const idx = messages.findIndex((m) => m.id === stopTarget.id)
        if (idx === -1) return messages
        const target = messages[idx]
        if (!target || target.role !== "assistant") return messages
        const next = [...messages] as Message[]
        next[idx] = {
          ...target,
          time: { ...target.time, completed: target.time?.completed ?? Date.now() },
          error: { name: "MessageAbortedError", data: { message: "Interrupted by user" } },
        }
        return next
      })
    }

    // Cancel any in-flight local prompt request. This is complementary to the
    // server-side abort below and must NOT replace it: the server abort is the
    // authoritative stop for both TS and Rust agents. A Rust run_loop's prompt
    // HTTP has already returned (it delegates to the background tokio task), so
    // only the server-side cancel can actually stop it.
    const queued = pending.get(sessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(sessionID)
    }
    // Re-pull a moment later. The Rust runLoop persists its own "stopped by
    // user" marker on the assistant message — and creates that message when the
    // stop landed before the first token was produced. The sync fired by the
    // working→idle effect can beat that write, so without this second pull the
    // stop can leave no visible trace until the next manual refresh.
    window.setTimeout(() => {
      void sync.session.sync(sessionID, { force: true }).catch(() => undefined)
    }, 1500)

    // Send abort request with timeout — if server doesn't respond within 3s,
    // force-reset session status to idle on the frontend
    const abortPromise = sdk.client.session.abort({ sessionID }).then((result) => {
      return result
    })

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        console.warn(
          `[abort] Server did not respond to abort for session ${sessionID} within 3s, forcing local idle state`,
        )
        sync.set("session_status", sessionID, { type: "idle" })
        resolve()
      }, 3000)
    })

    return Promise.race([abortPromise, timeoutPromise]).catch((err) => {
      // Abort request itself failed (network error, server down, etc.)
      console.warn(`[abort] Failed to abort session ${sessionID}:`, err?.message || err)
      // Force-reset UI state since server may be unreachable
      sync.set("session_status", sessionID, { type: "idle" })
    })
  }

  const restoreCommentItems = (items: CommentItem[]) => {
    for (const item of items) {
      prompt.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const restoreContextItems = (items: (ContextItem & { key: string })[]) => {
    for (const item of items) {
      prompt.context.add(item)
    }
  }

  const removeCommentItems = (items: { key: string }[]) => {
    for (const item of items) {
      prompt.context.remove(item.key)
    }
  }

  const clearContext = () => {
    for (const item of prompt.context.items()) {
      prompt.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    const [, setStore] = globalSync.child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const textFiles = currentPrompt.filter((part) => part.type === "text-file")
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && textFiles.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    // Clear input immediately so the user sees instant feedback.
    // If the send fails, restoreInput() will put the text back.
    const clearInput = () => {
      prompt.reset()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      prompt.set(currentPrompt, input.promptLength(currentPrompt))
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
    }

    clearInput()

    const projectDirectory = sdk.directory
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk.client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              variant: "error",
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          restoreInput()
          return
        }
        WorktreeState.pending(createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk.createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        globalSync.child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info()
    if (!session && isNewSession) {
      const created = await client.session
        .create()
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          showToast({
            variant: "error",
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        session = created
        if (shouldAutoAccept) permission.enableAutoAccept(session.id, sessionDirectory)
        local.session.promote(sessionDirectory, session.id)
        layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        seed(sessionDirectory, created)
        navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      restoreInput()
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const context = prompt.context.items().slice()
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      locale: language.locale(),
    }

    input.onSubmit?.()

    if (mode === "shell") {
      clearInput()
      client.session
        .shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        .catch((err) => {
          showToast({
            variant: "error",
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName!.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        client.session
          .command({
            sessionID: session.id,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            parts: images.map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
      // Gear command routing: `/<gear>` → activate endpoint. With a tail, the
      // tail is sent as the real prompt (the gear's instructions are now injected).
      if (isCommandGear(commandName)) {
        clearInput()
        try {
          await activateGear(commandName)
          showToast({
            variant: "success",
            title: language.t("dialog.gear.activate.success", { name: commandName }),
          })
        } catch (err) {
          showToast({
            variant: "error",
            title: language.t("dialog.gear.activate.failed", { name: commandName }),
            description: String(err),
          })
          restoreInput()
          return
        }
        const tail = args.join(" ").trim()
        if (!tail) return
        // Continue as a normal send with the tail as the prompt.
        draft.prompt = [{ type: "text", content: tail, start: 0, end: tail.length }]
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync.session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    // Save all context items for restore on send failure
    const savedContextItems = context.slice()

    removeCommentItems(commentItems)
    // Clear all context items after sending — the file contents are already
    // persisted as synthetic text parts in the message history (DB), so the LLM
    // can see them via toModelMessagesEffect. Keeping context items would cause
    // the same file to be re-read and re-sent on every subsequent message,
    // duplicating file content in the LLM context and wasting tokens.
    clearContext()
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync.set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        restoreCommentItems(commentItems)
        restoreContextItems(savedContextItems)
        restoreInput()
      }

      pending.set(session.id, { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([WorktreeState.wait(sessionDirectory), abortWait, timeout]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(session.id)
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    // Session busy (a runLoop is running): queue the message instead of
    // hitting the backend's fail-fast 409. The composer's idle watcher
    // (SessionComposerRegion) pumps the queue when the session turns idle.
    // The `send` closure captures the exact context the direct path would
    // use, so dequeue replays an identical send.
    const enqueueQueuedPrompt = () => {
      promptQueue.enqueue({
        id: messageID,
        sessionID: session.id,
        directory: sessionDirectory,
        preview: text.trim(),
        createdAt: Date.now(),
        send: () =>
          sendFollowupDraft({
            client,
            sync,
            globalSync,
            draft,
            messageID,
            optimisticBusy: sessionDirectory === projectDirectory,
            before: waitForWorktree,
            cascadeQA: input.cascadeQA,
            autoAccept: input.autoAccept,
          }).catch((err) => {
            pending.delete(session.id)
            removeOptimisticMessage()
            throw err
          }),
      })
      showToast({
        title: language.t("session.queue.enqueued.title"),
        description: language.t("session.queue.enqueued.description"),
      })
    }

    if (input.working()) {
      enqueueQueuedPrompt()
      return
    }

    void sendFollowupDraft({
      client,
      sync,
      globalSync,
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
      cascadeQA: input.cascadeQA,
      autoAccept: input.autoAccept,
    }).catch((err) => {
      pending.delete(session.id)
      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "idle" })
      }
      const msg = errorMessage(err)
      // Fail-fast 409: project already has a running task (race between the
      // pre-send idle check above and /task/acquire). Queue the message with
      // the same UX as the pre-send busy branch instead of erroring out.
      if (isProjectTaskBusyError(msg)) {
        removeOptimisticMessage()
        enqueueQueuedPrompt()
        return
      }
      showToast({
        variant: "error",
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: msg,
      })
      removeOptimisticMessage()
      restoreCommentItems(commentItems)
      restoreContextItems(savedContextItems)
      restoreInput()
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
