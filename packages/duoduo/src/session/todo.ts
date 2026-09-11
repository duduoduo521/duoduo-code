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
  readonly update: (input: {
    sessionID: SessionID
    todos: Info[]
    /** Who is updating the list. "ai" applies the no-skip-ordering guard (问题3);
     *  "user" bypasses it. Defaults to "user". */
    source?: "ai" | "user"
  }) => Effect.Effect<void, DuoduoError>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const update = Effect.fn("Todo.update")(function* (
      input: { sessionID: SessionID; todos: Info[]; source?: "ai" | "user" },
    ) {
      // [T-03] Validate statuses + transitions against the previous state. Todos
      // are matched to their prior version by content (the de-facto identity used
      // by `update`, which replaces the whole list).
      const prev = yield* get(input.sessionID)
      const prevByContent = new Map(prev.map((t) => [t.content, t.status]))
      for (const todo of input.todos) {
        if (!ALLOWED_STATUSES.has(todo.status)) {
          return yield* Effect.fail(
            new DuoduoError({
              message: t({
                en: `Invalid todo status: "${todo.status}" (allowed: pending / in_progress / completed / cancelled)`,
                zh: `非法任务状态: "${todo.status}"（允许: pending / in_progress / completed / cancelled）`,
              }),
              cause: undefined,
            }),
          )
        }
        if (todo.content.length > 0 && prevByContent.has(todo.content)) {
          const from = prevByContent.get(todo.content)!
          if (!isValidTransition(from, todo.status)) {
            return yield* Effect.fail(
              new DuoduoError({
                message: t({
                  en: `Illegal status transition: "${todo.content}" ${from} → ${todo.status}`,
                  zh: `非法状态流转: "${todo.content}" ${from} → ${todo.status}`,
                }),
                cause: undefined,
              }),
            )
          }
        }
      }

      // [T-04 / 问题3] When the AI updates the list, enforce ordered execution:
      // it must not skip ahead to a later task while an earlier one is still
      // pending. Cancelled tasks are ignored for ordering. This prevents the
      // agent from silently dropping earlier checklist items.
      if (input.source === "ai") {
        const ordered = input.todos
          .map((t, position) => ({ t, position }))
          .filter(({ t }) => t.status !== "cancelled")
          .sort((a, b) => a.position - b.position)
        let firstPendingIdx = ordered.findIndex(({ t }) => t.status === "pending")
        if (firstPendingIdx !== -1) {
          const firstPending = ordered[firstPendingIdx]
          for (let i = firstPendingIdx + 1; i < ordered.length; i++) {
            const st = ordered[i]!.t.status
            if (st === "in_progress" || st === "completed") {
              return yield* Effect.fail(
                new DuoduoError({
                  message: t({
                    en: `Execute the task list in order: you cannot start or complete "${ordered[i]!.t.content}" before "${firstPending!.t.content}" (pending) is done. Please work on the earlier unfinished item first.`,
                    zh: `请按顺序执行任务清单：在「${firstPending!.t.content}」(pending) 完成之前，不能先开始/完成「${ordered[i]!.t.content}」。请先处理靠前的未完成项。`,
                  }),
                  cause: undefined,
                }),
              )
            }
          }
        }
      }

      yield* Effect.sync(() =>
        Database.projectTransaction((db) => {
          db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
          if (input.todos.length === 0) return
          db.insert(TodoTable)
            .values(
              input.todos.map((todo, position) => ({
                session_id: input.sessionID,
                content: todo.content,
                status: todo.status,
                priority: todo.priority ?? "",
                position,
              })),
            )
            .run()
        }),
      )
      yield* bus.publish(Event.Updated, input)
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      const rows = yield* Effect.sync(() =>
        Database.useProject((db) =>
          db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
        ),
      )
      return rows.map((row) => ({
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
