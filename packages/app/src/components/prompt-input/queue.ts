import { createStore } from "solid-js/store"

/**
 * Client-side prompt queue (Plan A).
 *
 * When a session is busy (a Rust runLoop is running), pressing Enter used to
 * fail with the backend's fail-fast 409 ("/task/acquire" with timeout: 0, see
 * duoduo/src/server/routes/instance/session.ts prompt_async). Instead of
 * surfacing that as an error toast, the message is now queued per session and
 * sent automatically as soon as the session turns idle.
 *
 * The queue lives in memory only (module-level Solid store): a queued entry
 * holds the exact FollowupDraft captured at submit time plus a `send` closure
 * bound to the same client/worktree-wait context the direct path would have
 * used, so dequeue replays the identical send. A page reload discards queued
 * entries — same tradeoff as the optimistic-message path.
 */

export interface QueuedPrompt {
  /** Pre-generated messageID (Identifier.ascending("message") at submit time). */
  id: string
  sessionID: string
  /** Session directory (may be a worktree, distinct from the project root). */
  directory: string
  /** Plain-text preview for the queue dock. */
  preview: string
  createdAt: number
  /** Set when the dequeue attempt failed; retried only via the dock's retry button. */
  failed?: boolean
  /** Performs the actual send (captured at enqueue time). */
  send: () => Promise<boolean>
}

const [queueStore, setQueueStore] = createStore<{
  items: Record<string, QueuedPrompt[]>
}>({ items: {} })

export const promptQueue = {
  items(sessionID: string): QueuedPrompt[] {
    return queueStore.items[sessionID] ?? []
  },

  size(sessionID: string): number {
    return (queueStore.items[sessionID] ?? []).length
  },

  enqueue(item: QueuedPrompt): void {
    const list = queueStore.items[item.sessionID] ?? []
    setQueueStore("items", item.sessionID, [...list, item])
  },

  remove(sessionID: string, id: string): void {
    setQueueStore(
      "items",
      sessionID,
      (queueStore.items[sessionID] ?? []).filter((q) => q.id !== id),
    )
  },

  /** Clear the transient failure flag so the pump will retry this entry. */
  retry(sessionID: string, id: string): void {
    const list = queueStore.items[sessionID] ?? []
    setQueueStore(
      "items",
      sessionID,
      list.map((q) => (q.id === id ? { ...q, failed: false } : q)),
    )
  },

  /**
   * Send the oldest queued prompt for the session, if any. Called from the
   * composer's idle watcher. The entry is removed before sending; on failure
   * it is put back at the front with `failed: true` (surfaced in the dock with
   * a retry action) instead of being retried in a hot loop.
   *
   * Returns true when a prompt was dequeued.
   */
  async pump(sessionID: string): Promise<boolean> {
    const list = queueStore.items[sessionID] ?? []
    const next = list[0]
    if (!next || next.failed) return false
    setQueueStore(
      "items",
      sessionID,
      list.filter((q) => q.id !== next.id),
    )
    try {
      await next.send()
      return true
    } catch (err) {
      const current = queueStore.items[sessionID] ?? []
      setQueueStore("items", sessionID, [{ ...next, failed: true }, ...current])
      throw err
    }
  },
}
