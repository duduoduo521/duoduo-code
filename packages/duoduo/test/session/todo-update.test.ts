import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as Todo from "@/session/todo"
import { it } from "bun:test"

// P2-6 (1-1/1-2): todo identity is the stable `id`. update() runs inside ONE
// project transaction (TOCTOU-free), matches existing rows by id with a
// content fallback for legacy rows, and assigns generated ids to brand-new
// tasks. The resolved list (canonical ids) is returned so the todowrite tool
// can echo ids back to the model.
describe("session.todo.update", () => {
  it("keeps matched ids, fills generated ids, and dedupes by identity", () =>
    testEffect(
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const todo = yield* Todo.Service
          const sessionID = "ses_todo_update"

          const created = yield* todo.update({
            sessionID,
            todos: [
              { content: "task one", status: "pending", priority: "high" },
              { content: "task two", status: "pending", priority: "low" },
            ],
          })
          expect(created).toHaveLength(2)
          expect(created[0]!.id).toBeTruthy()
          expect(created[1]!.id).toBeTruthy()
          expect(created[0]!.id).not.toBe(created[1]!.id)

          // Updating with the ids echoed back keeps identity stable.
          const updated = yield* todo.update({
            sessionID,
            todos: [
              { id: created[0]!.id, content: "task one", status: "completed", priority: "high" },
              created[1]!,
            ],
          })
          expect(updated[0]!.id).toBe(created[0]!.id)
          expect(updated[0]!.status).toBe("completed")

          // Legacy fallback: a row without id can be addressed by content.
          const legacy = yield* todo.update({
            sessionID,
            todos: [{ content: "task two", status: "in_progress", priority: "low" }],
          })
          expect(legacy).toHaveLength(1)
          expect(legacy[0]!.id).toBe(created[1]!.id)

          // get() exposes the same canonical ids (legacy rows fall back to
          // content — exercised via direct table writes elsewhere).
          const fetched = yield* todo.get(sessionID)
          expect(fetched.map((t) => t.id)).toEqual(legacy.map((t) => t.id))
        }),
      ),
    ),
  )
})
