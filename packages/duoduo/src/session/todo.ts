import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import z from "zod"
import { Database, eq, asc } from "../storage"
import { TodoTable } from "./session.sql"
import { DuoduoError } from "@/util/error"
import { t } from "@/util/locale"

// [T-03] Allowed todo statuses and their valid transitions. The `Info` schema
// only documents these in prose; we enforce them server-side so an LLM mistake
// cannot produce illegal states (e.g. completed → in_progress, or → pending).
const ALLOWED_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"])
const TERMINAL_STATUSES = new Set(["completed", "cancelled"])

export function isValidTransition(from: string, to: string): boolean {
  if (from === to) return true
  if (!ALLOWED_STATUSES.has(to)) return false
  // Terminal states cannot be left; nothing can revert back to pending.
  if (TERMINAL_STATUSES.has(from)) return false
  if (to === "pending") return false
  return true
}

export const Info = z
  .object({
    // [1-1] Stable identity. The model MUST pass back the id when updating an
    // existing task; omitting it is only valid for brand-new tasks (backend
    // generates one). Legacy rows written before this column existed fall
    // back to content matching (read side: id = content).
    id: z
      .string()
      .optional()
      .describe(
        "Stable id of an existing task. When updating an existing task you MUST pass back its id; omit it only when creating a brand-new task.",
      ),
    content: z.string().describe("Brief description of the task"),
    status: z
      .string()
      .describe(
        "Current status of the task. Allowed values: 'pending' (not started), 'in_progress' (currently working on it), 'completed' (finished), 'cancelled' (no longer needed). Valid transitions: pending→in_progress→completed, pending→cancelled. You MUST set status to 'in_progress' before working on a task, and set to 'completed' immediately after finishing it.",
      ),
    priority: z.string().describe("Priority level of the task: high, medium, low"),
  })
  .meta({ ref: "Todo" })
export type Info = z.infer<typeof Info>

export const Event = {
  Updated: BusEvent.define(
    "todo.updated",
    z.object({
      sessionID: SessionID.zod,
      todos: z.array(Info),
    }),
  ),
}

export interface Interface {
  // Resolves to the persisted todo list (ids filled in for brand-new tasks) so
  // the todowrite tool can echo the CANONICAL ids back to the model — the
  // todowrite prompt requires the model to pass ids back on updates, and it
  // can only do that if the tool result carries them.
  readonly update: (input: { sessionID: SessionID; todos: Info[] }) => Effect.Effect<Info[], DuoduoError>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: Info[] }) {
      // [1-2] Read-validate-write inside ONE transaction: the previous state is
      // read from the same snapshot the delete+insert commits against, so two
      // concurrent updates can no longer lose each other's writes (TOCTOU).
      const resolved = yield* Effect.try({
        try: () =>
          Database.projectTransaction((db): Info[] => {
            const fail = (en: string, zh: string): never => {
              throw new DuoduoError({ message: t({ en, zh }), cause: undefined })
            }
            const rows = db
              .select()
              .from(TodoTable)
              .where(eq(TodoTable.session_id, input.sessionID))
              .orderBy(asc(TodoTable.position))
              .all()
            // [1-1] Identity is the stable `id`. Legacy rows written before
            // the column existed have id = NULL — fall back to content
            // matching so old sessions keep working.
            const prevById = new Map(rows.map((r) => [r.id ?? r.content, r]))
            const prevByContent = new Map(rows.map((r) => [r.content, r]))

            // [T-03] Validate statuses + transitions against the previous state.
            for (const todo of input.todos) {
              if (!ALLOWED_STATUSES.has(todo.status)) {
                fail(
                  `Invalid todo status: "${todo.status}" (allowed: pending / in_progress / completed / cancelled)`,
                  `非法任务状态: "${todo.status}"（允许: pending / in_progress / completed / cancelled）`,
                )
              }
              const matched =
                (todo.id ? prevById.get(todo.id) : undefined) ??
                (todo.content.length > 0 ? prevByContent.get(todo.content) : undefined)
              if (matched && !isValidTransition(matched.status, todo.status)) {
                fail(
                  `Illegal status transition: "${todo.content}" ${matched.status} → ${todo.status}`,
                  `非法状态流转: "${todo.content}" ${matched.status} → ${todo.status}`,
                )
              }
            }

            // [T-04] Enforce ordered execution: the list must not skip ahead to
            // a later task while an earlier one is still pending. Cancelled
            // tasks are ignored for ordering. This prevents the agent from
            // silently dropping earlier checklist items.
            const ordered = input.todos
              .map((t, position) => ({ t, position }))
              .filter(({ t }) => t.status !== "cancelled")
              .sort((a, b) => a.position - b.position)
            const firstPendingIdx = ordered.findIndex(({ t }) => t.status === "pending")
            if (firstPendingIdx !== -1) {
              const firstPending = ordered[firstPendingIdx]!
              for (let i = firstPendingIdx + 1; i < ordered.length; i++) {
                const st = ordered[i]!.t.status
                if (st === "in_progress" || st === "completed") {
                  fail(
                    `Execute the task list in order: you cannot start or complete "${ordered[i]!.t.content}" before "${firstPending.t.content}" (pending) is done. Please work on the earlier unfinished item first.`,
                    `请按顺序执行任务清单：在「${firstPending.t.content}」(pending) 完成之前，不能先开始/完成「${ordered[i]!.t.content}」。请先处理靠前的未完成项。`,
                  )
                }
              }
            }

            db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
            if (input.todos.length === 0) return []
            // M6 (D1-1): two NEW inputs with the same content and no id each
            // mint a fresh UUID and land as duplicate rows with distinct keys —
            // the same shadowing symptom the seenIds check below guards, which
            // only fires when two inputs resolve to the SAME id. Reject the
            // input shape up front (the documented contract: update an
            // existing task by passing its id).
            const newWithoutId = new Set<string>()
            for (const todo of input.todos) {
              if (!todo.id && todo.content.length > 0) {
                if (newWithoutId.has(todo.content)) {
                  throw new DuoduoError({
                    message: `Duplicate new task "${todo.content}" (no id) — pass the existing task's id to update it`,
                    messageZh: `新任务 "${todo.content}"（无 id）重复——更新既有任务请回传其 id`,
                    cause: undefined,
                  })
                }
                newWithoutId.add(todo.content)
              }
            }
            // [1-1] Keep the matched row's stable id; brand-new tasks get a
            // generated one (an explicit id from the model is honored so a
            // deleted-then-recreated task keeps its identity). An empty-string
            // id counts as "no id" (it must never reach the DB or the UI key).
            const resolvedTodos: Array<Info & { id: string }> = input.todos.map((todo) => {
              const requestedId = todo.id || undefined
              const id =
                (requestedId ? prevById.get(requestedId)?.id : undefined) ??
                (todo.content.length > 0 ? prevByContent.get(todo.content)?.id : undefined) ??
                requestedId ??
                crypto.randomUUID()
              return { id, content: todo.content, status: todo.status, priority: todo.priority ?? "" }
            })
            // D1-1: two inputs resolving to the SAME id (duplicate content
            // without ids) would land duplicate reconcile keys in the UI and
            // silently shadow a row on the next update (its T-03 check would
            // be skipped). Reject the whole write instead.
            const seenIds = new Set<string>()
            for (const t of resolvedTodos) {
              if (seenIds.has(t.id)) {
                throw new DuoduoError({
                  message: `Duplicate task "${t.content}" (id ${t.id}) — each task in the list must be unique`,
                  messageZh: `任务 "${t.content}"（id ${t.id}）重复——列表中每个任务必须唯一`,
                  cause: undefined,
                })
              }
              seenIds.add(t.id)
            }
            db.insert(TodoTable)
              .values(
                resolvedTodos.map((todo, position) => ({
                  session_id: input.sessionID,
                  id: todo.id,
                  content: todo.content,
                  status: todo.status,
                  priority: todo.priority,
                  position,
                })),
              )
              .run()
            return resolvedTodos
          }),
        catch: (e) =>
          e instanceof DuoduoError
            ? e
            : new DuoduoError({ message: "todo update failed", messageZh: "任务清单更新失败", cause: e }),
      })

      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: resolved })
      return resolved
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      const rows = yield* Effect.sync(() =>
        Database.useProject((db) =>
          db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
        ),
      )
      // [1-1] Legacy rows have id = NULL — expose id = content so consumers
      // (frontend reconcile, tool descriptions) always see a stable key.
      return rows.map((row) => ({
        id: row.id ?? row.content,
        content: row.content,
        status: row.status,
        priority: row.priority,
      }))
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Todo from "./todo"
