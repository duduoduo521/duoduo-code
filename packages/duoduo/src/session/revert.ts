import z from "zod"
import { Effect, Layer, Context } from "effect"
import { Bus } from "../bus"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage"
import { Log } from "../util"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"
import { DuoduoError } from "@/util/error"
import { Instance } from "@/project/instance"
import { createSmartLayerClients } from "@/smart-layer"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import path from "path"

/**
 * P1-5: after a revert, two auxilliary indexes are now stale relative to the
 * restored worktree:
 *  1. the knowledge graph still holds entities from the rolled-back content;
 *  2. project memory still holds cascade QA verdicts for content that no
 *     longer exists (a stale "passed" could later suppress a needed check).
 * KG entries self-heal on the next file change, but we refresh eagerly since
 * we already know the exact file set (same updateFile entry the watcher uses).
 * Cascade memory cannot be deleted via the existing search API, so we write a
 * marker memory that supersedes the invalidated verdicts (marker-not-delete,
 * per the decision in 缺陷调查.md 10-1).
 */
function refreshAuxIndexesAfterRevert(files: string[]) {
  if (files.length === 0) return
  const clients = createSmartLayerClients()
  if (!clients) return
  const directory = Instance.directory
  for (const file of files) {
    void (async () => {
      try {
        const abs = path.isAbsolute(file) ? file : path.join(directory, file)
        const content = await import("fs/promises").then((fs) => fs.readFile(abs, "utf-8"))
        const rel = path.relative(directory, abs).split(path.sep).join("/")
        const language = LANGUAGE_EXTENSIONS[path.extname(file)] ?? "plaintext"
        await clients.graph?.updateFile(rel, content, language, directory)
      } catch (e) {
        log.warn("post-revert KG refresh failed (self-heals on next file change)", {
          file,
          error: String(e),
        })
      }
    })()
  }
  clients.memory
    ?.store(
      `Reverted worktree changes affecting ${files.length} file(s): ${files.slice(0, 20).join(", ")}. All prior cascade QA verdicts for these files are INVALIDATED — re-verify before relying on them.`,
      "episode",
      {
        memoryType: "cascade_invalidation",
        tags: ["cascade", "invalidated"],
        projectPath: directory,
        metadata: { files },
      },
    )
    .catch(() => {})
}

const log = Log.create({ service: "session.revert" })

export const RevertInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod,
  partID: PartID.zod.optional(),
})
export type RevertInput = z.infer<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, DuoduoError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, DuoduoError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID })
      let lastUser: MessageV2.User | undefined
      const session = yield* sessions.get(input.sessionID)

      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (part.type === "patch") patches.push(part)
            continue
          }

          if (!rev) {
            if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              rev = {
                messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      if (!rev) return session

      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track("revert baseline"))
      // S-02 (B1): refuse to overwrite uncommitted edits BEFORE restoring the
      // baseline. Restoring would otherwise silently clobber any manual user
      // edits made since the last roll. `hasUncommitted` diffs the worktree
      // against the baseline tree directly, so it is not blinded by the shadow
      // index having been staged via track()/patch() (defect B root cause).
      //
      // The gate only applies when this revert would actually write to the
      // worktree: restoring a previous baseline (`snap.restore`, guarded by
      // `session.revert.snapshot`) or rolling back patch parts (`snap.revert`).
      // With no baseline to restore and an empty patch list, `snap.revert([])`
      // is a no-op (it builds an empty op list and returns without running any
      // git command) — the revert is a pure message-level truncation, so there
      // is nothing for the gate to protect and it must not block the operation.
      // This is the case that made retrying a failed turn (e.g. HTTP 429 before
      // any tool ran) fail with "uncommitted changes" while touching no file.
      const mutatesWorktree = !!session.revert?.snapshot || patches.length > 0
      if (mutatesWorktree && (yield* snap.hasUncommitted(rev.snapshot!))) {
        return yield* Effect.fail(
          new DuoduoError({
            message:
              "Workspace has uncommitted changes since the last rollback; rolling back would overwrite them. Commit or stash first, or use the force option.",
            messageZh:
              "自上次回滚以来工作区存在未提交的变更，回滚会覆盖这些手动修改。请先提交或 stash，或使用 force 选项强制回滚。",
          }),
        )
      }
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* snap.revert(patches)
      if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
      const range = all.filter((msg) => msg.info.id >= rev.messageID)
      const diffs = yield* summary.computeDiff({ messages: range })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      // P1-5: collect the exact file set whose on-disk content the revert
      // changed — `patches` carry `files[]` directly; the restore path (when
      // `rev.snapshot` is set) is covered by parsing `rev.diff` (a git diff
      // text, `diff --git a/<file> b/<file>` headers). Refresh KG + invalidate
      // cascade verdicts for them (fire-and-forget, never fails the revert).
      {
        const affected = new Set<string>()
        for (const p of patches) for (const f of p.files) affected.add(f)
        if (rev.diff) {
          for (const m of rev.diff.matchAll(/^diff --git a\/(.+?) b\//gm)) {
            if (m[1]) affected.add(m[1])
          }
        }
        refreshAuxIndexesAfterRevert([...affected])
      }
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      return yield* sessions.get(input.sessionID)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID })
      const messageID = session.revert.messageID
      const remove = [] as MessageV2.WithParts[]
      let target: MessageV2.WithParts | undefined
      for (const msg of msgs) {
        if (msg.info.id < messageID) continue
        if (msg.info.id > messageID) {
          remove.push(msg)
          continue
        }
        if (session.revert.partID) {
          target = msg
          continue
        }
        remove.push(msg)
      }
      for (const msg of remove) {
        // Route through Session.removeMessage so the RUST_SINGLE_WRITE flag is
        // honored. Calling SyncEvent.run directly would throw "Projector not
        // found" when the flag is on (Removed/PartRemoved projectors are not
        // registered) and the delete would never reach the DB.
        yield* sessions.removeMessage({
          sessionID,
          messageID: msg.info.id,
        })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sessions.removePart({
              sessionID,
              messageID: target.info.id,
              partID: part.id,
            })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionSummary.defaultLayer),
  ),
)

export * as SessionRevert from "./revert"
