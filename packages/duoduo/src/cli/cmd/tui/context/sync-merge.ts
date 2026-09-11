import type { Message, Part } from "@duoduo-ai/sdk/v2"

export interface DbMessage {
  info: Message
  parts: Part[]
}

export interface MergeResult {
  messages: Message[]
  parts: Map<string, Part[]>
}

/**
 * Upsert-merge DB messages/parts with the in-memory (SSE-live) copy.
 *
 * INVARIANT (regression guard): for any message we already hold in memory,
 * the live object + parts are ALWAYS preserved, and the DB parts only
 * backfill parts memory is missing. We never replace a live message's
 * parts with the DB snapshot, because when `session.status` idle fires a
 * `force` sync, the DB write can lag the live SSE stream by
 * milliseconds — so a DB snapshot taken at that instant may be missing
 * the just-streamed text part (only the earlier reasoning part present).
 * Trusting the DB there would wipe the freshly-streamed answer
 * ("reply vanished, only 'thinking' left"). See
 * packages/duoduo/test/context/sync-merge.test.ts.
 */
export function mergeSessionMessages(
  dbMsgs: DbMessage[],
  memMsgs: Message[],
  memParts: Map<string, Part[]>,
): MergeResult {
  const memById = new Map(memMsgs.map((m) => [m.id, m]))
  const mergedMsgs: Message[] = []
  const mergedParts = new Map<string, Part[]>()
  for (const dbm of dbMsgs) {
    const mem = memById.get(dbm.info.id)
    if (mem) {
      // Message already live in memory → keep it and its parts; backfill
      // only DB parts that memory does not have.
      mergedMsgs.push(mem)
      const memPartList = memParts.get(dbm.info.id) ?? []
      const memPartIds = new Set(memPartList.map((p) => p.id))
      mergedParts.set(
        dbm.info.id,
        [...memPartList, ...dbm.parts.filter((p) => !memPartIds.has(p.id))],
      )
    } else {
      // Cold-load: message exists only in the DB → use DB info + parts.
      mergedMsgs.push(dbm.info)
      mergedParts.set(dbm.info.id, dbm.parts)
    }
    memById.delete(dbm.info.id)
  }
  // Append any messages that exist only in memory (not yet persisted to DB).
  for (const m of memById.values()) {
    mergedMsgs.push(m)
    mergedParts.set(m.id, memParts.get(m.id) ?? [])
  }
  mergedMsgs.sort((a, b) =>
    a.time.created === b.time.created
      ? a.id.localeCompare(b.id)
      : a.time.created - b.time.created,
  )
  return { messages: mergedMsgs, parts: mergedParts }
}
