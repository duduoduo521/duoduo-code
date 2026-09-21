import { Slug } from "@duoduo-ai/shared/util/slug"
import path from "path"
import { projectDataDir } from "@/storage/project-dir"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { type ProviderMetadata, type LanguageModelUsage } from "ai"
import { Flag } from "../flag/flag"
import { InstallationVersion } from "../installation/version"

import { Database, NotFoundError, eq, and, gte, isNull, desc, like, inArray, lt, sql } from "../storage"
import { SyncEvent } from "../sync"
import type { SQL } from "../storage"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import { ProjectTable } from "../project/project.sql"
import { Storage } from "@/storage"
import { Log } from "../util"
import { updateSchema } from "../util/update-schema"
import { MessageV2 } from "./message-v2"
import { ownership } from "./ownership"
import { Instance } from "../project/instance"
import { InstanceState } from "@/effect"
import { Snapshot } from "@/snapshot"
import { ProjectID } from "../project/schema"
import { WorkspaceID } from "../control-plane/schema"
import { SessionID, MessageID, PartID } from "./schema"

import type { Provider } from "@/provider"
import { Permission } from "@/permission"
import { Global } from "@/global"
import { Effect, Layer, Option, Context } from "effect"
import { triggerOnDelete } from "./cascade-qa-registry"
import { createSmartLayerClients } from "@/smart-layer"
import { NamedError } from "@duoduo-ai/shared/util/error"

const log = Log.create({ service: "session" })

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

function createDefaultTitle(isChild = false) {
  return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
}

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

type SessionRow = typeof SessionTable.$inferSelect

export function fromRow(row: SessionRow): Info {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  const revert = row.revert ?? undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    parentID: row.parent_id ?? undefined,
    title: row.title,
    version: row.version,
    summary,
    revert,
    permission: row.permission ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

export function toRow(info: Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    title: info.title,
    version: info.version,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs,
    revert: info.revert ?? null,
    permission: info.permission,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]!
    const num = parseInt(match[2]!, 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}

export const Info = z
  .object({
    id: SessionID.zod,
    slug: z.string(),
    projectID: ProjectID.zod,
    workspaceID: WorkspaceID.zod.optional(),
    directory: z.string(),
    parentID: SessionID.zod.optional(),
    summary: z
      .object({
        additions: z.number(),
        deletions: z.number(),
        files: z.number(),
        diffs: Snapshot.FileDiff.zod.array().optional(),
      })
      .optional(),
    title: z.string(),
    version: z.string(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      compacting: z.number().optional(),
      archived: z.number().optional(),
    }),
    permission: Permission.Ruleset.zod.optional(),
    revert: z
      .object({
        messageID: MessageID.zod,
        partID: PartID.zod.optional(),
        snapshot: z.string().optional(),
        diff: z.string().optional(),
      })
      .optional(),
  })
  .meta({
    ref: "Session",
  })
export type Info = z.output<typeof Info>

export const ProjectInfo = z
  .object({
    id: ProjectID.zod,
    name: z.string().optional(),
    worktree: z.string(),
  })
  .meta({
    ref: "ProjectSummary",
  })
export type ProjectInfo = z.output<typeof ProjectInfo>

export const GlobalInfo = Info.extend({
  project: ProjectInfo.nullable(),
}).meta({
  ref: "GlobalSession",
})
export type GlobalInfo = z.output<typeof GlobalInfo>

export const CreateInput = z
  .object({
    parentID: SessionID.zod.optional(),
    title: z.string().optional(),
    permission: Info.shape.permission,
    workspaceID: WorkspaceID.zod.optional(),
  })
  .optional()
export type CreateInput = z.output<typeof CreateInput>

export const ForkInput = z.object({ sessionID: SessionID.zod, messageID: MessageID.zod.optional() })
export const GetInput = SessionID.zod
export const ChildrenInput = SessionID.zod
export const RemoveInput = SessionID.zod
export const SetTitleInput = z.object({ sessionID: SessionID.zod, title: z.string() })
export const SetArchivedInput = z.object({ sessionID: SessionID.zod, time: z.number().optional() })
export const SetPermissionInput = z.object({ sessionID: SessionID.zod, permission: Permission.Ruleset.zod })
export const SetRevertInput = z.object({
  sessionID: SessionID.zod,
  revert: Info.shape.revert,
  summary: Info.shape.summary,
})
export const MessagesInput = z.object({ sessionID: SessionID.zod, limit: z.number().optional() })

export const Event = {
  Created: SyncEvent.define({
    type: "session.created",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  }),
  Updated: SyncEvent.define({
    type: "session.updated",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: updateSchema(Info).extend({
        time: updateSchema(Info.shape.time).optional(),
      }),
    }),
    busSchema: z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  }),
  Deleted: SyncEvent.define({
    type: "session.deleted",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  }),
  Diff: BusEvent.define(
    "session.diff",
    z.object({
      sessionID: SessionID.zod,
      diff: Snapshot.FileDiff.zod.array(),
    }),
  ),
  Error: BusEvent.define(
    "session.error",
    z.object({
      sessionID: SessionID.zod.optional(),
      // z.lazy defers access to break circular dep: session → message-v2 → provider → plugin → session
      error: z.lazy(() => (MessageV2.Assistant.zod as unknown as z.ZodObject<any>).shape.error),
    }),
  ),
}

export function plan(input: { slug: string; time: { created: number } }) {
  const base = Instance.project.vcs
    ? path.join(projectDataDir(Instance.worktree), "plans")
    : path.join(Global.Path.data, "plans")
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}

// Normalize a provider usage payload into the token-count shape used by
// message/part schemas and context accounting. Cost is intentionally NOT
// computed here — this project only serves local/custom models and does not
// bill usage.
export const getTokens = (input: { usage: LanguageModelUsage; metadata?: ProviderMetadata }) => {
  const safe = (value: number) => (Number.isFinite(value) ? value : 0)
  const inputTokens = safe(input.usage.inputTokens ?? 0)
  const outputTokens = safe(input.usage.outputTokens ?? 0)
  const reasoningTokens = safe(
    input.usage.outputTokenDetails?.reasoningTokens ?? input.usage.reasoningTokens ?? 0,
  )
  const cacheReadInputTokens = safe(
    input.usage.inputTokenDetails?.cacheReadTokens ?? input.usage.cachedInputTokens ?? 0,
  )
  const cacheWriteInputTokens = safe(
    Number(
        input.usage.inputTokenDetails?.cacheWriteTokens ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0,
    ),
  )

  // AI SDK v6 normalized inputTokens to include cached tokens across all providers.
  // Subtract cache tokens to get the non-cached input count for context accounting.
  const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)

  // Many openai-compatible providers (e.g. DeepSeek) omit totalTokens in
  // streamed usage. Fall back to input + output so the footer token count
  // always renders instead of being dropped as `undefined`.
  const totalTokens = safe(input.usage.totalTokens ?? inputTokens + outputTokens)

  return {
    total: totalTokens,
    input: adjustedInputTokens,
    output: safe(outputTokens - reasoningTokens),
    reasoning: reasoningTokens,
    cache: {
      write: cacheWriteInputTokens,
      read: cacheReadInputTokens,
    },
  }
}

export class BusyError extends Error {
  constructor(public readonly sessionID: string) {
    super(`Session ${sessionID} is busy`)
  }
}

export interface Interface {
  readonly create: (input?: {
    parentID?: SessionID
    title?: string
    permission?: Permission.Ruleset
    workspaceID?: WorkspaceID
  }) => Effect.Effect<Info>
  readonly fork: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Info>
  readonly touch: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (id: SessionID) => Effect.Effect<Info>
  readonly setTitle: (input: { sessionID: SessionID; title: string }) => Effect.Effect<void>
  readonly setArchived: (input: { sessionID: SessionID; time?: number }) => Effect.Effect<void>
  readonly setPermission: (input: { sessionID: SessionID; permission: Permission.Ruleset }) => Effect.Effect<void>
  readonly setRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly clearRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly setSummary: (input: { sessionID: SessionID; summary: Info["summary"] }) => Effect.Effect<void>
  readonly diff: (sessionID: SessionID) => Effect.Effect<Snapshot.FileDiff[]>
  readonly messages: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<MessageV2.WithParts[]>
  readonly children: (parentID: SessionID) => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void>
  readonly updateMessage: <T extends MessageV2.Info>(msg: T) => Effect.Effect<T>
  readonly removeMessage: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MessageID>
  readonly removePart: (input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) => Effect.Effect<PartID>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
  }) => Effect.Effect<MessageV2.Part | undefined>
  readonly updatePart: <T extends MessageV2.Part>(part: T) => Effect.Effect<T>
  readonly updatePartDelta: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    field: string
    delta: string
  }) => Effect.Effect<void>
  /** Finds the first message matching the predicate, searching newest-first. */
  readonly findMessage: (
    sessionID: SessionID,
    predicate: (msg: MessageV2.WithParts) => boolean,
  ) => Effect.Effect<Option.Option<MessageV2.WithParts>>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/Session") {}

type Patch = z.infer<typeof Event.Updated.schema>["info"]

const db = <T>(fn: (d: Parameters<typeof Database.useProject>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.useProject(fn))

export const layer: Layer.Layer<Service, never, Bus.Service | Storage.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const storage = yield* Storage.Service

    const createNext = Effect.fn("Session.createNext")(function* (input: {
      id?: SessionID
      title?: string
      parentID?: SessionID
      workspaceID?: WorkspaceID
      directory: string
      permission?: Permission.Ruleset
    }) {
      const ctx = yield* InstanceState.context
      const result: Info = {
        id: SessionID.descending(input.id),
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: ctx.project.id,
        directory: input.directory,
        workspaceID: input.workspaceID,
        parentID: input.parentID,
        title: input.title ?? createDefaultTitle(!!input.parentID),
        permission: input.permission,
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      log.info("created", result)

      yield* Effect.sync(() => SyncEvent.run(Event.Created, { sessionID: result.id, info: result }))

      if (!Flag.DUODUO_EXPERIMENTAL_WORKSPACES) {
        // This only exist for backwards compatibility. We should not be
        // manually publishing this event; it is a sync event now
        yield* bus.publish(Event.Updated, {
          sessionID: result.id,
          info: result,
        })
      }

      return result
    })

    const get = Effect.fn("Session.get")(function* (id: SessionID) {
      const row = yield* db((d) => d.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
      if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
      return fromRow(row)
    })

    const children = Effect.fn("Session.children")(function* (parentID: SessionID) {
      const rows = yield* db((d) =>
        d
          .select()
          .from(SessionTable)
          .where(and(eq(SessionTable.parent_id, parentID)))
          .all(),
      )
      return rows.map(fromRow)
    })

    const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID) {
// @effect-diagnostics-next-line tryCatchInEffectGen:off
      try {
        // Use CTE to fetch all descendant session IDs in a single query (fixes N+1).
        // Returns rows sorted by depth DESC so we process children before parents.
        const descendants = yield* db((d) =>
          d.all<{ id: string; depth: number }>(sql`
            WITH RECURSIVE tree AS (
              SELECT id, 0 AS depth FROM session WHERE id = ${sessionID}
              UNION ALL
              SELECT s.id, t.depth + 1 FROM session s INNER JOIN tree t ON s.parent_id = t.id
            )
            SELECT id, depth FROM tree ORDER BY depth DESC
          `),
        )

        // Fetch full row data for all sessions via drizzle (preserves JSON parsing, type mapping)
        const descendantIDs = descendants.map((r) => r.id as SessionID)
        const rows =
          descendantIDs.length > 0
            ? yield* db((d) => d.select().from(SessionTable).where(inArray(SessionTable.id, descendantIDs)).all())
            : []
        const sessions = new Map(rows.map((row) => [row.id, fromRow(row)]))

        // `remove` needs to work in all cases, such as a broken
        // sessions that run cleanup. In certain cases these will
        // run without any instance state, so we need to turn off
        // publishing of events in that case
        const hasInstance = yield* InstanceState.directory.pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        )

        // Process in depth-descending order: children first, then parents
        for (const { id } of descendants) {
          const sid = id as SessionID
          const session = sessions.get(sid)
          if (!session) continue

          yield* Effect.sync(() => {
            SyncEvent.run(Event.Deleted, { sessionID: sid, info: session }, { publish: hasInstance })
            SyncEvent.remove(sid)
            triggerOnDelete(sid)
          })
        }
      } catch (e) {
        log.error(e)
      }
    })

    const updateMessage = <T extends MessageV2.Info>(msg: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        if (ownership.isRust(msg.sessionID)) {
          // Rust-owned session invariant: Rust persists ASSISTANT
          // messages (written during its runLoop); TS persists USER messages.
          // Rust has NO upsert route for user messages and its runLoop reads
          // history from the project DB — without this direct write the user
          // message never lands in the DB and the loop runs with zero user
          // input (root cause of the "greeting triggers tool calls" bug).
          // Mirrors the fork path's direct Drizzle write (see `fork` above).
          if (msg.role === "user") {
            yield* Effect.sync(() => {
              const { id, sessionID, ...rest } = msg
              Database.useProject((db) =>
                db
                  .insert(MessageTable)
                  .values({ id, session_id: sessionID, time_created: msg.time.created, data: rest })
                  .onConflictDoUpdate({ target: MessageTable.id, set: { data: rest } })
                  .run(),
              )
            })
          }
          // Publish the event for frontend sync (Rust owns assistant rows).
          yield* bus.publish(MessageV2.Event.Updated, { sessionID: msg.sessionID, info: msg })
        } else {
          yield* Effect.sync(() => SyncEvent.run(MessageV2.Event.Updated, { sessionID: msg.sessionID, info: msg }))
        }
        log.debug("message.updated", { sessionID: msg.sessionID, messageID: msg.id, role: msg.role })
        return msg
      }).pipe(Effect.withSpan("Session.updateMessage"))

    const updatePart = <T extends MessageV2.Part>(part: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        // Shallow clone with nested-object spread — avoids structuredClone deep-copy cost.
        // Only spread properties that exist on this specific Part variant.
        const cloned: Record<string, unknown> = { ...part }
        if ("time" in part && part.time && typeof part.time === "object") cloned.time = { ...part.time }
        if ("state" in part && part.state && typeof part.state === "object") cloned.state = { ...part.state }
        if ("metadata" in part && part.metadata && typeof part.metadata === "object")
          cloned.metadata = { ...part.metadata }
        if (ownership.isRust(part.sessionID)) {
          // Rust-owned session invariant: Rust persists parts of
          // ASSISTANT messages (text/reasoning/tool parts written during its
          // runLoop); TS persists parts of USER messages (the prompt text and
          // attachments). Without this, the user's text part never reaches the
          // project DB and the Rust runLoop reconstructs an empty user turn.
          // Tool/assistant parts are intentionally NOT written here to avoid
          // racing Rust's own writes (pending→completed transitions).
          const parentIsUser = yield* Effect.sync(() =>
            Database.useProject((db) => {
              const row = db
                .select({ data: MessageTable.data })
                .from(MessageTable)
                .where(eq(MessageTable.id, part.messageID))
                .get()
              return row ? (row.data as { role?: string }).role === "user" : false
            }),
          )
          if (parentIsUser) {
            yield* Effect.sync(() => {
              const { id, messageID, sessionID, ...rest } = part
              Database.useProject((db) =>
                db
                  .insert(PartTable)
                  .values({ id, message_id: messageID, session_id: sessionID, time_created: Date.now(), data: rest })
                  .onConflictDoUpdate({ target: PartTable.id, set: { data: rest } })
                  .run(),
              )
            })
          }
          yield* bus.publish(MessageV2.Event.PartUpdated, {
            sessionID: part.sessionID,
            part: cloned as MessageV2.Part,
            time: Date.now(),
          })
        } else {
          yield* Effect.sync(() =>
            SyncEvent.run(MessageV2.Event.PartUpdated, {
              sessionID: part.sessionID,
              part: cloned as MessageV2.Part,
              time: Date.now(),
            }),
          )
        }
        log.debug("part.updated", {
          sessionID: part.sessionID,
          messageID: part.messageID,
          partID: part.id,
          type: part.type,
          ...(part.type === "tool"
            ? {
                tool: (part as Extract<MessageV2.Part, { type: "tool" }>).tool,
                status: (part as Extract<MessageV2.Part, { type: "tool" }>).state.status,
              }
            : {}),
        })
        return part
      }).pipe(Effect.withSpan("Session.updatePart"))

    const getPart: Interface["getPart"] = Effect.fn("Session.getPart")(function* (input) {
      const row = Database.useProject((db) =>
        db
          .select()
          .from(PartTable)
          .where(
            and(
              eq(PartTable.session_id, input.sessionID),
              eq(PartTable.message_id, input.messageID),
              eq(PartTable.id, input.partID),
            ),
          )
          .get(),
      )
      if (!row) return
      return {
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      } as MessageV2.Part
    })

    const create = Effect.fn("Session.create")(function* (input?: {
      parentID?: SessionID
      title?: string
      permission?: Permission.Ruleset
      workspaceID?: WorkspaceID
    }) {
      const directory = yield* InstanceState.directory
      const workspace = yield* InstanceState.workspaceID
      return yield* createNext({
        parentID: input?.parentID,
        directory,
        title: input?.title,
        permission: input?.permission,
        workspaceID: workspace,
      })
    })

    const fork = Effect.fn("Session.fork")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const directory = yield* InstanceState.directory
      const original = yield* get(input.sessionID)
      const title = getForkedTitle(original.title)
      const session = yield* createNext({
        directory,
        workspaceID: original.workspaceID,
        title,
        parentID: input.sessionID,
      })
      const msgs = yield* messages({ sessionID: input.sessionID })
      const idMap = new Map<string, MessageID>()

      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        const newID = MessageID.ascending()
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const clonedInfo: MessageV2.Info = {
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        }

        if (ownership.isRust(session.id)) {
          // Fork is new-session initialization — must write to DB directly because
          // Rust does not know about these cloned messages. Under Rust ownership,
          // the projector skips persistence, so SyncEvent.run won't persist.
          // Use Drizzle insert directly, plus publish SSE for frontend sync.
          yield* Effect.sync(() => {
            const time_created = clonedInfo.time.created
            const { id, sessionID, ...rest } = clonedInfo
            Database.useProject((db) =>
              db
                .insert(MessageTable)
                .values({ id, session_id: sessionID, time_created, data: rest })
                .onConflictDoUpdate({ target: MessageTable.id, set: { data: rest } })
                .run(),
            )
          })
          yield* bus.publish(MessageV2.Event.Updated, { sessionID: session.id, info: clonedInfo })
        } else {
          yield* updateMessage(clonedInfo)
        }

        for (const part of msg.parts) {
          const clonedPart: MessageV2.Part = {
            ...part,
            id: PartID.ascending(),
            messageID: newID,
            sessionID: session.id,
          }

          if (ownership.isRust(session.id)) {
            yield* Effect.sync(() => {
              const { id, messageID, sessionID, ...rest } = clonedPart
              Database.useProject((db) =>
                db
                  .insert(PartTable)
                  .values({ id, message_id: messageID, session_id: sessionID, time_created: Date.now(), data: rest })
                  .onConflictDoUpdate({ target: PartTable.id, set: { data: rest } })
                  .run(),
              )
            })
            // Shallow clone for SSE publish (matches updatePart behavior)
            const cloned: Record<string, unknown> = { ...clonedPart }
            if ("time" in clonedPart && clonedPart.time && typeof clonedPart.time === "object")
              cloned.time = { ...clonedPart.time }
            if ("state" in clonedPart && clonedPart.state && typeof clonedPart.state === "object")
              cloned.state = { ...clonedPart.state }
            if ("metadata" in clonedPart && clonedPart.metadata && typeof clonedPart.metadata === "object")
              cloned.metadata = { ...clonedPart.metadata }
            yield* bus.publish(MessageV2.Event.PartUpdated, {
              sessionID: session.id,
              part: cloned as MessageV2.Part,
              time: Date.now(),
            })
          } else {
            yield* updatePart(clonedPart)
          }
        }
      }
      return session
    })

    const patch = (sessionID: SessionID, info: Patch) =>
      Effect.sync(() => SyncEvent.run(Event.Updated, { sessionID, info }))

    const touch = Effect.fn("Session.touch")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() } })
    })

    const setTitle = Effect.fn("Session.setTitle")(function* (input: { sessionID: SessionID; title: string }) {
      yield* patch(input.sessionID, { title: input.title })
    })

    const setArchived = Effect.fn("Session.setArchived")(function* (input: { sessionID: SessionID; time?: number }) {
      yield* patch(input.sessionID, { time: { archived: input.time } })
    })

    const setPermission = Effect.fn("Session.setPermission")(function* (input: {
      sessionID: SessionID
      permission: Permission.Ruleset
    }) {
      yield* patch(input.sessionID, { permission: input.permission, time: { updated: Date.now() } })
    })

    const setRevert = Effect.fn("Session.setRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"]
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { summary: input.summary, time: { updated: Date.now() }, revert: input.revert })
    })

    const clearRevert = Effect.fn("Session.clearRevert")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() }, revert: null })
    })

    const setSummary = Effect.fn("Session.setSummary")(function* (input: {
      sessionID: SessionID
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { time: { updated: Date.now() }, summary: input.summary })
    })

    const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
      return yield* storage
        .read<Snapshot.FileDiff[]>(["session_diff", sessionID])
        .pipe(Effect.orElseSucceed((): Snapshot.FileDiff[] => []))
    })

    const messages = Effect.fn("Session.messages")(function* (input: { sessionID: SessionID; limit?: number }) {
      if (input.limit) {
        return MessageV2.page({ sessionID: input.sessionID, limit: input.limit }).items
      }
      return Array.from(MessageV2.stream(input.sessionID)).reverse()
    })

    const removeMessage = Effect.fn("Session.removeMessage")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      if (ownership.isRust(input.sessionID)) {
        // Rust-owned session: the Rust sidecar may hold in-memory caches for
        // these rows, so route the delete through it. Then publish via Bus
        // for frontend sync.
        const clients = createSmartLayerClients()
        if (clients?.agent) {
          yield* Effect.tryPromise({
            try: () => clients.agent.deleteMessage(input.messageID),
            catch: (e) => new NamedError.Unknown({ message: `Failed to delete message via Rust: ${e}` }),
          }).pipe(
            // Keep the interface never-failing (this runs in the high-frequency
            // revert cleanup path). Log delete failures and still publish the
            // Bus event so the frontend stays in sync; the next sync reconciles.
            Effect.catch((e) => Effect.sync(() => log.error("removeMessage rust delete failed", { error: String(e) }))),
          )
        }
        yield* bus.publish(MessageV2.Event.Removed, {
          sessionID: input.sessionID,
          messageID: input.messageID,
        })
      } else {
        yield* Effect.sync(() =>
          SyncEvent.run(MessageV2.Event.Removed, {
            sessionID: input.sessionID,
            messageID: input.messageID,
          }),
        )
      }
      return input.messageID
    })

    const removePart = Effect.fn("Session.removePart")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      if (ownership.isRust(input.sessionID)) {
        // Rust-owned session: the Rust sidecar may hold in-memory caches for
        // these rows, so route the delete through it. Then publish via Bus
        // for frontend sync.
        const clients = createSmartLayerClients()
        if (clients?.agent) {
          yield* Effect.tryPromise({
            try: () => clients.agent.deletePart(input.partID),
            catch: (e) => new NamedError.Unknown({ message: `Failed to delete part via Rust: ${e}` }),
          }).pipe(
            // Keep the interface never-failing (this runs in the high-frequency
            // revert cleanup path). Log delete failures and still publish the
            // Bus event so the frontend stays in sync; the next sync reconciles.
            Effect.catch((e) => Effect.sync(() => log.error("removePart rust delete failed", { error: String(e) }))),
          )
        }
        yield* bus.publish(MessageV2.Event.PartRemoved, {
          sessionID: input.sessionID,
          messageID: input.messageID,
          partID: input.partID,
        })
      } else {
        yield* Effect.sync(() =>
          SyncEvent.run(MessageV2.Event.PartRemoved, {
            sessionID: input.sessionID,
            messageID: input.messageID,
            partID: input.partID,
          }),
        )
      }
      return input.partID
    })

    const updatePartDelta = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      field: string
      delta: string
    }) {
      yield* bus.publish(MessageV2.Event.PartDelta, input)
    })

    /** Finds the first message matching the predicate, searching newest-first. */
    const findMessage = Effect.fn("Session.findMessage")(function* (
      sessionID: SessionID,
      predicate: (msg: MessageV2.WithParts) => boolean,
    ) {
      for (const item of MessageV2.stream(sessionID)) {
        if (predicate(item)) return Option.some(item)
      }
      return Option.none<MessageV2.WithParts>()
    })

    return Service.of({
      create,
      fork,
      touch,
      get,
      setTitle,
      setArchived,
      setPermission,
      setRevert,
      clearRevert,
      setSummary,
      diff,
      messages,
      children,
      remove,
      updateMessage,
      removeMessage,
      removePart,
      updatePart,
      getPart,
      updatePartDelta,
      findMessage,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(Storage.defaultLayer))

export function* list(input?: {
  directory?: string
  workspaceID?: WorkspaceID
  roots?: boolean
  start?: number
  search?: string
  limit?: number
}) {
  const project = Instance.project
  const conditions = [eq(SessionTable.project_id, project.id)]

  if (input?.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (!Flag.DUODUO_EXPERIMENTAL_WORKSPACES) {
    if (input?.directory) {
      conditions.push(eq(SessionTable.directory, input.directory))
    }
  }
  if (input?.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input?.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input?.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }

  const limit = input?.limit ?? 100

  const rows = Database.useProject((db) =>
    db
      .select()
      .from(SessionTable)
      .where(and(...conditions))
      .orderBy(desc(SessionTable.time_updated))
      .limit(limit)
      .all(),
  )
  for (const row of rows) {
    yield fromRow(row)
  }
}

export function* listGlobal(input?: {
  directory?: string
  roots?: boolean
  start?: number
  cursor?: number
  search?: string
  limit?: number
  archived?: boolean
}) {
  const conditions: SQL[] = []

  if (input?.directory) {
    conditions.push(eq(SessionTable.directory, input.directory))
  }
  if (input?.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input?.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input?.cursor) {
    conditions.push(lt(SessionTable.time_updated, input.cursor))
  }
  if (input?.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }
  if (!input?.archived) {
    conditions.push(isNull(SessionTable.time_archived))
  }

  const limit = input?.limit ?? 100

  // Sessions are stored in PER-PROJECT databases (`<data dir>/database/<project_id>/duoduo.db`),
  // so a global listing must aggregate across every project's DB. Querying via
  // `useProject` would (a) require an Instance context this global API should not
  // need and (b) only ever see the current project's sessions. Instead we enumerate
  // all projects from the global DB and merge each project's top-`limit` sessions.
  const projects = Database.use((db) =>
    db
      .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
      .from(ProjectTable)
      .all(),
  )

  const projectById = new Map<string, ProjectInfo>()
  for (const item of projects) {
    projectById.set(item.id, {
      id: item.id,
      name: item.name ?? undefined,
      worktree: item.worktree,
    })
  }

  type SessionRow = typeof SessionTable.$inferSelect
  const merged: { row: SessionRow; project: ProjectInfo | null }[] = []
  for (const item of projects) {
    // The global top-`limit` is a subset of the union of each project's own
    // top-`limit`, so bounding each per-DB query with `.limit(limit)` is correct
    // and keeps memory/work proportional to (projects × limit) rather than total
    // session count. Projects whose DB file does not exist are skipped.
    const rows = Database.withProjectDb(item.worktree, (db) => {
      const query =
        conditions.length > 0
          ? db.select().from(SessionTable).where(and(...conditions))
          : db.select().from(SessionTable)
      return query.orderBy(desc(SessionTable.time_updated), desc(SessionTable.id)).limit(limit).all()
    })
    if (!rows) continue
    const project = projectById.get(item.id) ?? null
    for (const row of rows) {
      merged.push({ row, project })
    }
  }

  // Merge across projects: most recently updated first, tie-break on id (desc),
  // mirroring the per-project `orderBy(desc(time_updated), desc(id))`.
  merged.sort((a, b) => {
    if (a.row.time_updated !== b.row.time_updated) return b.row.time_updated - a.row.time_updated
    if (a.row.id === b.row.id) return 0
    return a.row.id > b.row.id ? -1 : 1
  })

  for (const item of merged.slice(0, limit)) {
    yield { ...fromRow(item.row), project: item.project }
  }
}
